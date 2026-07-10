/**
 * Clear stale Stripe PaymentIntent IDs left behind after a gateway switch.
 *
 * When a store moves to a new Stripe account, a new Stripe mode (test to
 * live), or a different payment gateway entirely, old orders keep the
 * previous PaymentIntent id in meta `_stripe_intent_id` (or
 * `transaction_id`). That id does not exist under the new secret key. Any
 * later action that reads it, a refund, a renewal charge, a sync job, fails
 * with a Stripe "No such payment_intent" error, even though the order
 * itself is fine.
 *
 * This walks recent orders, tries to resolve the saved id against the
 * current Stripe account, and clears the stale meta (and adds a note) on
 * orders whose id cannot be resolved and whose payment already finished.
 * It never touches an order whose id resolves fine, and it never touches
 * an order that is still waiting on payment. Read only by default.
 *
 * Guide: https://www.allanninal.dev/woocommerce/stale-ids-after-a-gateway-switch/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 90);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const FINISHED_STATUSES = new Set(["processing", "completed", "refunded", "on-hold"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision. lookupResult is one of:
 * "resolved"  the id was found in the current Stripe account
 * "not_found" Stripe returned resource_missing for the id
 * "no_id"     the order has no saved PaymentIntent id at all
 */
export function decide(order, lookupResult) {
  if (!FINISHED_STATUSES.has(order.status)) {
    return ["skip", "order is not yet finished, leave the id alone"];
  }
  if (lookupResult === "no_id") return ["skip", "no PaymentIntent id saved on this order"];
  if (lookupResult === "resolved") return ["skip", "id resolves fine in the current Stripe account"];
  if (lookupResult === "not_found") {
    return ["clear", "id does not exist in the current Stripe account, stale from a gateway switch"];
  }
  return ["skip", "unknown lookup result"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function lookupIntent(intentId) {
  if (!intentId) return "no_id";
  try {
    await stripe.paymentIntents.retrieve(intentId);
    return "resolved";
  } catch (err) {
    if (err.code === "resource_missing" || err.statusCode === 404) return "not_found";
    throw err;
  }
}

async function* recentOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function clearStaleId(order, oldIntentId) {
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({
      transaction_id: "",
      meta_data: [{ key: "_stripe_intent_id", value: "" }],
    }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Cleared a stale Stripe PaymentIntent id (${oldIntentId}) left over from a gateway ` +
            `switch. This id does not exist in the current Stripe account, so it was removed to ` +
            `stop future actions on this order from failing.`,
    }),
  });
}

export async function run() {
  let cleared = 0;
  for await (const order of recentOrders()) {
    const oldIntentId = intentIdOf(order);
    const lookupResult = await lookupIntent(oldIntentId);
    const [action, reason] = decide(order, lookupResult);
    if (action !== "clear") continue;
    console.warn(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would clear" : "clearing"}`);
    if (!DRY_RUN) await clearStaleId(order, oldIntentId);
    cleared++;
  }
  console.log(`Done. ${cleared} order(s) ${DRY_RUN ? "to clear" : "cleared"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
