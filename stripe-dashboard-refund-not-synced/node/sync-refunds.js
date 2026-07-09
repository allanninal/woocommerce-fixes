/**
 * Record Stripe dashboard refunds that never synced to WooCommerce.
 * Uses api_refund false, so it never refunds the customer twice.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/stripe-dashboard-refund-not-synced/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 72);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* recentRefundedCharges(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  const seen = new Set();
  for await (const refund of stripe.refunds.list({ limit: 100, created: { gte: since } })) {
    const chargeId = refund.charge;
    if (!chargeId || seen.has(chargeId)) continue;
    seen.add(chargeId);
    const charge = await stripe.charges.retrieve(chargeId);
    const orderId = (charge.metadata || {}).order_id;
    if (orderId) yield { orderId, charge };
  }
}

export function wcRefundedMinor(refunds) {
  return refunds.reduce((sum, r) => sum + Math.round(Math.abs(parseFloat(r.amount)) * 100), 0);
}

export function missingRefundMinor(stripeRefundedMinor, refunds) {
  const gap = stripeRefundedMinor - wcRefundedMinor(refunds);
  return gap > 1 ? gap : 0;
}

async function recordRefund(orderId, amountMinor) {
  await woo(`/orders/${orderId}/refunds`, {
    method: "POST",
    body: JSON.stringify({
      amount: (amountMinor / 100).toFixed(2),
      reason: "Recorded from a Stripe dashboard refund. No money moved on Stripe.",
      api_refund: false,
    }),
  });
}

export async function run() {
  let recorded = 0;
  for await (const { orderId, charge } of recentRefundedCharges(LOOKBACK_HOURS)) {
    const refunds = await woo(`/orders/${orderId}/refunds`);
    if (refunds === null) { console.warn(`Charge for order ${orderId} but the order is missing in Woo`); continue; }
    const missing = missingRefundMinor(charge.amount_refunded, refunds);
    if (!missing) continue;
    console.log(`Order ${orderId}: Stripe refunded ${missing} more than Woo has. ${DRY_RUN ? "would record" : "recording"}`);
    if (!DRY_RUN) await recordRefund(orderId, missing);
    recorded++;
  }
  console.log(`Done. ${recorded} refund(s) ${DRY_RUN ? "to record" : "recorded"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
