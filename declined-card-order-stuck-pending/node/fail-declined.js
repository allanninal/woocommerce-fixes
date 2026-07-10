/**
 * Move WooCommerce orders left on Pending by a declined Stripe card to Failed.
 * Frees the held stock. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/declined-card-order-stuck-pending/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const MIN_AGE_HOURS = Number(process.env.MIN_AGE_HOURS || 2);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function isDeclined(intent) {
  if (intent.status !== "requires_payment_method") return false;
  return Boolean(intent.last_payment_error);
}

export function getMeta(order, key) {
  const hit = (order.meta_data || []).find((m) => m.key === key);
  return hit ? hit.value : null;
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* pendingStripeOrders(beforeIso) {
  let page = 1;
  while (true) {
    const orders = await woo(`/orders?status=pending&payment_method=stripe&before=${beforeIso}&per_page=50&page=${page}`);
    if (!orders.length) return;
    for (const order of orders) yield order;
    page++;
  }
}

export async function run() {
  const before = new Date(Date.now() - MIN_AGE_HOURS * 3600 * 1000).toISOString();
  let failed = 0;
  for await (const order of pendingStripeOrders(before)) {
    const intentId = getMeta(order, "_stripe_intent_id");
    if (!intentId) continue;
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (!isDeclined(intent)) continue;
    const error = intent.last_payment_error || {};
    const reason = error.message || error.code || "card declined";
    console.log(`Order ${order.id}: declined (${reason}). ${DRY_RUN ? "would fail" : "failing"}`);
    if (!DRY_RUN) {
      await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status: "failed" }) });
      await woo(`/orders/${order.id}/notes`, { method: "POST", body: JSON.stringify({ note: `Stripe declined the payment: ${reason}. Marked failed to release stock.` }) });
    }
    failed++;
  }
  console.log(`Done. ${failed} order(s) ${DRY_RUN ? "to fail" : "failed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
