/**
 * Find WooCommerce subscriptions still charging a legacy Stripe SEPA Source and
 * migrate them to a supported SEPA Debit PaymentMethod before the next renewal fails.
 *
 * Stripe stopped accepting old `src_...` Sources for off-session SEPA renewals. An
 * order or subscription that still points at one of these will be rejected at the
 * next charge. This walks recent renewal orders, reads the saved token, and for any
 * legacy Source, looks up the Stripe Customer for a newer SEPA Debit PaymentMethod
 * that can replace it. When one exists it re-links the order; otherwise it flags the
 * order for the shopper to re-enter their IBAN. Safe by default (DRY_RUN=true).
 *
 * Guide: https://www.allanninal.dev/woocommerce/old-sepa-sources-rejected/
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

const RENEWAL_STATUSES = new Set(["pending", "on-hold", "failed"]);
const LEGACY_SOURCE_PREFIX = "src_";
const SEPA_PM_TYPE = "sepa_debit";

export function tokenOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  return order.transaction_id || null;
}

export function isLegacySource(token) {
  return Boolean(token) && token.startsWith(LEGACY_SOURCE_PREFIX);
}

/**
 * Pure decision: what should we do about this order's saved payment token.
 *
 * order: object with at least { status, id }.
 * token: the saved Stripe token string, or null.
 * replacementPm: a SEPA Debit PaymentMethod id (string) found on the customer, or null.
 *
 * Returns [action, reason] where action is one of "skip", "migrate", "flag".
 */
export function decide(order, token, replacementPm) {
  if (!RENEWAL_STATUSES.has(order.status)) {
    return ["skip", "order is not awaiting or retrying a renewal"];
  }
  if (!isLegacySource(token)) {
    return ["skip", "saved token is not a legacy Source"];
  }
  if (replacementPm) {
    return ["migrate", "legacy Source found, a SEPA Debit PaymentMethod is available"];
  }
  return ["flag", "legacy Source found, no SEPA Debit PaymentMethod on file"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function findSepaPaymentMethod(customerId) {
  if (!customerId) return null;
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: SEPA_PM_TYPE, limit: 10 });
  if (!methods.data.length) return null;
  const newest = methods.data.reduce((a, b) => (a.created > b.created ? a : b));
  return newest.id;
}

function stripeCustomerIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_customer_id" && meta.value) return meta.value;
  }
  return null;
}

async function* renewalOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=pending,on-hold,failed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function migrate(order, replacementPm) {
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "_stripe_intent_id", value: replacementPm },
        { key: "_stripe_source_id", value: replacementPm },
      ],
    }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Migrated from a legacy Stripe SEPA Source to PaymentMethod ${replacementPm}. ` +
            `This order can now be retried or will use the new token on the next renewal.`,
    }),
  });
}

async function flag(order, reason) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `SEPA payment check failed: ${reason}. This order is on a legacy Stripe Source ` +
            `that Stripe no longer accepts for renewals, and no replacement SEPA Debit ` +
            `PaymentMethod was found. The shopper needs to re-enter their IBAN on the account page.`,
    }),
  });
}

export async function run() {
  let migrated = 0;
  let flagged = 0;
  for await (const order of renewalOrders()) {
    const token = tokenOf(order);
    const customerId = stripeCustomerIdOf(order);
    const replacementPm = isLegacySource(token) ? await findSepaPaymentMethod(customerId) : null;
    const [action, reason] = decide(order, token, replacementPm);
    if (action === "skip") continue;
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would " + action : action + "ing"}`);
    if (action === "migrate") {
      if (!DRY_RUN) await migrate(order, replacementPm);
      migrated++;
    } else if (action === "flag") {
      if (!DRY_RUN) await flag(order, reason);
      flagged++;
    }
  }
  console.log(
    `Done. ${migrated} order(s) ${DRY_RUN ? "to migrate" : "migrated"}, ` +
    `${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
