/**
 * Replay Stripe webhook events WooCommerce missed during downtime.
 * Idempotent. Run once after an outage, or on a schedule as a safety net.
 *
 * Guide: https://www.allanninal.dev/woocommerce/replay-missed-stripe-webhook-events/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 120);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function extractAction(event) {
  const obj = (event.data && event.data.object) || {};
  const orderId = (obj.metadata || {}).order_id;
  if (!orderId) return null;
  if (event.type === "payment_intent.succeeded") return { action: "complete", orderId, obj };
  if (event.type === "charge.refunded") return { action: "refund", orderId, obj };
  return null;
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

async function* undeliveredEvents(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  const params = { limit: 100, created: { gte: since }, delivery_success: false,
                   types: ["payment_intent.succeeded", "charge.refunded"] };
  for await (const event of stripe.events.list(params)) yield event;
}

async function syncRefund(order, charge) {
  const orderTotalMinor = Math.round(parseFloat(order.total) * 100);
  const stripeRefunded = charge.amount_refunded || 0;
  const wcRefunded = (order.refunds || []).reduce((s, r) => s + Math.round(Math.abs(parseFloat(r.total)) * 100), 0);
  const missing = stripeRefunded - wcRefunded;
  if (missing > 1) {
    await woo(`/orders/${order.id}/refunds`, { method: "POST", body: JSON.stringify({ amount: (missing / 100).toFixed(2), api_refund: false, reason: "Replayed a missed Stripe refund event." }) });
    if (stripeRefunded >= orderTotalMinor && order.status !== "refunded") {
      await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status: "refunded" }) });
    }
  }
}

async function applyEvent(action, orderId, obj) {
  const order = await woo(`/orders/${orderId}`);
  if (!order) return false;
  if (action === "complete" && !PAID_STATUSES.has(order.status)) {
    const chargeId = obj.latest_charge || obj.id;
    await woo(`/orders/${orderId}`, { method: "PUT", body: JSON.stringify({ status: "processing", transaction_id: chargeId }) });
    await woo(`/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ note: "Replayed a missed Stripe payment event. Marked processing." }) });
    return true;
  }
  if (action === "refund") { await syncRefund(order, obj); return true; }
  return false;
}

export async function run() {
  const seen = new Set();
  let applied = 0;
  for await (const event of undeliveredEvents(LOOKBACK_HOURS)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const parsed = extractAction(event);
    if (!parsed) continue;
    const { action, orderId, obj } = parsed;
    console.log(`Event ${event.id} -> ${action} order ${orderId}. ${DRY_RUN ? "dry run" : "applying"}`);
    if (!DRY_RUN && await applyEvent(action, orderId, obj)) applied++;
  }
  console.log(`Done. ${applied} event(s) ${DRY_RUN ? "found" : "reapplied"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
