/**
 * Link cards migrated from an old processor to the right WooCommerce customer.
 *
 * This does not move card numbers. It reads a mapping file your old processor
 * and Stripe produced during a card migration (old customer id -> new Stripe
 * PaymentMethod id), attaches each migrated PaymentMethod to a Stripe Customer,
 * and saves the new ids on the matching WooCommerce customer. Run once per
 * migration batch. Safe to run again, since already-linked customers are skipped.
 *
 * Guide: https://www.allanninal.dev/woocommerce/import-cards-from-another-processor/
 */
import Stripe from "stripe";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const MAPPING_FILE = process.env.MAPPING_FILE || "migration_mapping.csv";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

/** Minimal CSV parser: no external dependency, good enough for a simple two column export. */
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row = {};
    header.forEach((key, i) => { row[key] = cells[i]; });
    return row;
  });
}

export function mappingRows(path) {
  const text = readFileSync(path, "utf8");
  return parseCsv(text).map((row) => ({
    oldCustomerId: row.old_customer_id,
    paymentMethodId: row.payment_method_id,
  }));
}

async function findCustomer(oldCustomerId) {
  const results = await woo(
    `/customers?meta_key=_old_processor_customer_id&meta_value=${oldCustomerId}&per_page=1`
  );
  return results[0] || null;
}

export function customerMeta(customer, key) {
  for (const meta of customer.meta_data || []) {
    if (meta.key === key) return meta.value;
  }
  return null;
}

/**
 * Pure decision: what should happen for this mapping row. No I/O here.
 *
 * Returns [action, reason] where action is one of:
 *   "orphan" - no WooCommerce customer matches this old processor id
 *   "skip"   - nothing to do (bad row, or already linked)
 *   "link"   - attach the migrated PaymentMethod and save the new ids
 */
export function decide(customer, row) {
  if (!customer) return ["orphan", "no WooCommerce customer for this old processor id"];
  if (!row.paymentMethodId || !String(row.paymentMethodId).startsWith("pm_")) {
    return ["skip", "mapping row has no usable Stripe PaymentMethod id"];
  }
  const existing = customerMeta(customer, "_stripe_payment_method_id");
  if (existing) return ["skip", "customer already has a linked Stripe PaymentMethod"];
  return ["link", "migrated PaymentMethod ready to attach"];
}

async function ensureStripeCustomer(customer) {
  const existing = customerMeta(customer, "_stripe_customer_id");
  if (existing) return existing;
  const created = await stripe.customers.create({
    email: customer.email,
    name: `${customer.first_name || ""} ${customer.last_name || ""}`.trim(),
  });
  return created.id;
}

async function linkPaymentMethod(customer, paymentMethodId) {
  const stripeCustomerId = await ensureStripeCustomer(customer);
  await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId });
  await stripe.customers.update(stripeCustomerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  await woo(`/customers/${customer.id}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "_stripe_customer_id", value: stripeCustomerId },
        { key: "_stripe_payment_method_id", value: paymentMethodId },
      ],
    }),
  });
}

export async function run() {
  let linked = 0;
  for (const row of mappingRows(MAPPING_FILE)) {
    const customer = await findCustomer(row.oldCustomerId);
    const [action, reason] = decide(customer, row);
    if (action === "orphan") {
      console.warn(`Old customer ${row.oldCustomerId} has no matching WooCommerce customer`);
      continue;
    }
    if (action === "skip") {
      console.log(`Old customer ${row.oldCustomerId}: ${reason}`);
      continue;
    }
    console.log(`Customer ${customer.id}: ${reason}. ${DRY_RUN ? "would link" : "linking"}`);
    if (!DRY_RUN) await linkPaymentMethod(customer, row.paymentMethodId);
    linked++;
  }
  console.log(`Done. ${linked} customer(s) ${DRY_RUN ? "to link" : "linked"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
