/**
 * Record Stripe refunds on non-card methods that the webhook skipped, and mark
 * fully refunded orders as Refunded. Uses api_refund false, never refunds twice.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/refund-webhook-skips-non-card-methods/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function isStripeApm(paymentMethod) {
  return paymentMethod.startsWith("stripe_");
}

export function refundAction(orderTotalMinor, stripeRefundedMinor, wcRefundedMinor) {
  const missing = Math.max(0, stripeRefundedMinor - wcRefundedMinor);
  const fully = stripeRefundedMinor >= orderTotalMinor && stripeRefundedMinor > 0;
  return { missing, fully };
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
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* paidStripeOrders() {
  let page = 1;
  while (true) {
    const orders = await woo(`/orders?status=processing,completed&per_page=50&page=${page}`);
    if (!orders.length) return;
    for (const order of orders) yield order;
    page++;
  }
}

async function stripeRefundedMinor(order) {
  const chargeId = getMeta(order, "_stripe_charge_id");
  if (!chargeId) return 0;
  const charge = await stripe.charges.retrieve(chargeId);
  return charge.amount_refunded || 0;
}

function wcRefundedMinor(order) {
  return (order.refunds || []).reduce((sum, r) => sum + Math.round(Math.abs(parseFloat(r.total)) * 100), 0);
}

export async function run() {
  let fixed = 0;
  for await (const order of paidStripeOrders()) {
    if (!isStripeApm(order.payment_method)) continue;
    const orderTotalMinor = Math.round(parseFloat(order.total) * 100);
    const { missing, fully } = refundAction(orderTotalMinor, await stripeRefundedMinor(order), wcRefundedMinor(order));
    const needsStatus = fully && order.status !== "refunded";
    if (!missing && !needsStatus) continue;
    console.log(`Order ${order.id}: record ${missing}, mark refunded=${needsStatus}. ${DRY_RUN ? "dry run" : "applying"}`);
    if (!DRY_RUN) {
      if (missing > 0) {
        await woo(`/orders/${order.id}/refunds`, { method: "POST", body: JSON.stringify({ amount: (missing / 100).toFixed(2), api_refund: false, reason: "Recorded a Stripe refund the webhook skipped for this method." }) });
      }
      if (needsStatus) await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status: "refunded" }) });
    }
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
