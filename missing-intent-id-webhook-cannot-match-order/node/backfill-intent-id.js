/**
 * Recover the Stripe PaymentIntent ID for WooCommerce orders that lost it,
 * so the order can be matched, completed, and refunded again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/missing-intent-id-webhook-cannot-match-order/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

export function getMeta(order, key) {
  const hit = (order.meta_data || []).find((m) => m.key === key);
  return hit ? hit.value : null;
}

export function needsBackfill(order) {
  if (!order.payment_method.startsWith("stripe")) return false;
  if (PAID_STATUSES.has(order.status)) return false;
  return !getMeta(order, "_stripe_intent_id");
}

async function* unpaidStripeOrders() {
  let page = 1;
  while (true) {
    const orders = await woo(`/orders?status=pending,on-hold&payment_method=stripe&per_page=50&page=${page}`);
    if (!orders.length) return;
    for (const order of orders) yield order;
    page++;
  }
}

async function findIntent(orderId) {
  const query = `metadata['order_id']:'${orderId}' AND status:'succeeded'`;
  const result = await stripe.paymentIntents.search({ query, limit: 1 });
  return result.data.length ? result.data[0] : null;
}

async function backfill(orderId, intent) {
  const chargeId = intent.latest_charge || intent.id;
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({
      status: "processing",
      transaction_id: chargeId,
      meta_data: [
        { key: "_stripe_intent_id", value: intent.id },
        { key: "_stripe_charge_id", value: chargeId },
      ],
    }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Recovered Stripe PaymentIntent ${intent.id} and backfilled the order. ` +
            `Marked processing by the repair script.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const order of unpaidStripeOrders()) {
    if (!needsBackfill(order)) continue;
    const orderId = order.id;
    const intent = await findIntent(orderId);
    if (!intent) { console.warn(`Order ${orderId} has no successful payment on Stripe. Left alone.`); continue; }
    console.log(`Order ${orderId}: recovered ${intent.id}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await backfill(orderId, intent);
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
