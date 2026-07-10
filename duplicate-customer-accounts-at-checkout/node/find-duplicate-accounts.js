/**
 * Find WordPress or WooCommerce customer accounts that got duplicated for one
 * email address during checkout.
 *
 * A checkout race (a double click, a slow network retry, or two tabs) can call
 * "create account" twice before the first request finishes, so WooCommerce ends
 * up with two separate customer accounts for one shopper: one with the order
 * history, one empty. This walks recent customers, groups them by a normalized
 * email, and for each pair reads the saved Stripe PaymentIntent on their orders
 * to confirm both accounts really were paid by the same person before it
 * reports a merge plan. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/duplicate-customer-accounts-at-checkout/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

function stripeCustomerOf(order, getIntent) {
  const intent = getIntent(intentIdOf(order));
  if (!intent) return null;
  return typeof intent.customer === "string" ? intent.customer : null;
}

export function groupByEmail(customers) {
  const groups = new Map();
  for (const customer of customers) {
    const key = normalizeEmail(customer.email);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(customer);
  }
  const result = {};
  for (const [email, group] of groups) {
    if (group.length > 1) result[email] = group;
  }
  return result;
}

export function pickSurvivor(customers) {
  return [...customers].sort((a, b) => {
    const byOrders = (b.orders_count || 0) - (a.orders_count || 0);
    if (byOrders !== 0) return byOrders;
    return (a.date_created || "").localeCompare(b.date_created || "");
  })[0];
}

/**
 * Pure decision for one email's group of duplicate customer accounts.
 *
 * Returns { action, reason, survivor, duplicates }:
 *   - "merge": duplicates have no orders, or their orders trace to the same
 *     Stripe customer as the survivor's orders. Safe to repoint and remove.
 *   - "review": a duplicate has orders that trace to a *different* Stripe
 *     customer than the survivor. Do not auto merge, a human should look.
 *   - "skip": fewer than two accounts share this email.
 */
export function decide(email, customers, ordersByCustomer, getIntent) {
  if (customers.length < 2) {
    return { action: "skip", reason: "not a duplicate", survivor: null, duplicates: [] };
  }

  const survivor = pickSurvivor(customers);
  const duplicates = customers.filter((c) => c.id !== survivor.id);

  const survivorStripeIds = new Set(
    (ordersByCustomer[survivor.id] || [])
      .map((o) => stripeCustomerOf(o, getIntent))
      .filter(Boolean)
  );

  for (const dup of duplicates) {
    const dupOrders = ordersByCustomer[dup.id] || [];
    if (dupOrders.length === 0) continue;
    const dupStripeIds = new Set(dupOrders.map((o) => stripeCustomerOf(o, getIntent)).filter(Boolean));
    const overlaps = [...dupStripeIds].some((id) => survivorStripeIds.has(id));
    if (dupStripeIds.size > 0 && survivorStripeIds.size > 0 && !overlaps) {
      return {
        action: "review",
        reason: `duplicate account ${dup.id} paid through a different Stripe customer, needs a human`,
        survivor,
        duplicates,
      };
    }
  }

  return { action: "merge", reason: "same email, same payer, safe to merge", survivor, duplicates };
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* listCustomers() {
  let page = 1;
  while (true) {
    const batch = await woo(`/customers?per_page=100&page=${page}&orderby=registered_date&order=desc`);
    if (!batch.length) return;
    for (const customer of batch) yield customer;
    page++;
  }
}

async function ordersForCustomer(customerId) {
  return woo(`/orders?customer=${customerId}&per_page=50`);
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function repointOrders(duplicateId, survivorId, orders) {
  for (const order of orders) {
    await woo(`/orders/${order.id}`, {
      method: "PUT",
      body: JSON.stringify({ customer_id: survivorId }),
    });
  }
  await woo(`/customers/${survivorId}`, {
    method: "POST",
    body: JSON.stringify({
      meta_data: [{ key: "_merged_duplicate_account", value: String(duplicateId) }],
    }),
  });
}

export async function run() {
  let reported = 0;
  const allCustomers = [];
  for await (const customer of listCustomers()) allCustomers.push(customer);

  const groups = groupByEmail(allCustomers);
  const ordersByCustomer = {};
  for (const group of Object.values(groups)) {
    for (const customer of group) {
      ordersByCustomer[customer.id] = await ordersForCustomer(customer.id);
    }
  }

  for (const [email, group] of Object.entries(groups)) {
    const { action, reason, survivor, duplicates } = decide(email, group, ordersByCustomer, getIntent);
    if (action === "skip") continue;
    if (action === "review") {
      console.warn(`Email ${email}: ${reason}`);
      reported++;
      continue;
    }
    console.log(
      `Email ${email}: ${reason}. Survivor ${survivor.id}, merge ${duplicates.map((d) => d.id)}.`
    );
    if (!DRY_RUN) {
      for (const dup of duplicates) {
        await repointOrders(dup.id, survivor.id, ordersByCustomer[dup.id] || []);
      }
    }
    reported++;
  }
  console.log(`Done. ${reported} duplicate email group(s) ${DRY_RUN ? "to merge" : "processed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
