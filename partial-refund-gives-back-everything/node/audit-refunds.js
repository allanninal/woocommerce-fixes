/**
 * Catch WooCommerce partial refunds that actually returned the whole charge.
 *
 * On an order whose PaymentIntent was captured for less than the order total
 * (a manual capture, a phone order finished outside checkout, a split payment),
 * WooCommerce computes "amount left to refund" from the order total instead of
 * the real Stripe amount_captured. Ask for a small partial refund and the
 * gateway can send Stripe a refund with no amount, or an amount larger than
 * what is actually left, so Stripe refunds the entire remaining balance.
 *
 * This script compares, per order, the refund the shop manager intended
 * (the WooCommerce refund line item) against what Stripe actually refunded on
 * the matching charge. When Stripe refunded more than intended, it writes an
 * order note flagging the gap. It never asks Stripe to move money and never
 * edits amounts. It only reports. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/partial-refund-gives-back-everything/
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

// Tolerance in cents for rounding noise between the two systems.
const TOLERANCE_MINOR = 1;

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && (tid.startsWith("pi_") || tid.startsWith("ch_")) ? tid : null;
}

export function wooIntendedRefundMinor(order) {
  return Math.round(parseFloat(order.total_refunded || 0) * 100);
}

export function stripeRefundedMinor(charge) {
  return (charge && charge.amount_refunded) || 0;
}

/**
 * Pure decision: compare the intended refund to what Stripe actually moved.
 *
 * order: object with at least "id" and "status".
 * charge: Stripe Charge-shaped object, or null if it could not be found.
 * wooIntendedMinor: cents the WooCommerce refund record says was refunded.
 * stripeRefundedMinorValue: cents Stripe's charge.amount_refunded reports.
 *
 * Returns [action, reason, overRefundMinor].
 */
export function decide(order, charge, wooIntendedMinor, stripeRefundedMinorValue) {
  if (!charge) return ["orphan", "no matching Stripe charge for this order", 0];
  if (wooIntendedMinor <= 0) return ["skip", "no refund recorded on this order", 0];
  const gap = stripeRefundedMinorValue - wooIntendedMinor;
  if (gap > TOLERANCE_MINOR) return ["overrefund", "Stripe refunded more than WooCommerce intended", gap];
  if (gap < -TOLERANCE_MINOR) return ["underrefund", "Stripe refunded less than WooCommerce intended", gap];
  return ["ok", "Stripe refund matches the intended amount", 0];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getChargeForIntent(intentId) {
  if (!intentId) return null;
  try {
    if (intentId.startsWith("ch_")) return await stripe.charges.retrieve(intentId);
    const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge"] });
    return intent.latest_charge || null;
  } catch {
    return null;
  }
}

async function* recentlyRefundedOrders(lookbackHours) {
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(
      `/orders?status=refunded,processing,completed&after=${since}&per_page=50&page=${page}`
    );
    if (!batch.length) return;
    for (const order of batch) {
      if (parseFloat(order.total_refunded || 0) > 0) yield order;
    }
    page++;
  }
}

async function flag(order, reason, overRefundMinor) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Refund check: ${reason}. Stripe returned ${(overRefundMinor / 100).toFixed(2)} ` +
            `more than the WooCommerce refund record shows. This usually means the order's ` +
            `captured amount differs from Stripe's actual amount_captured (a manual or ` +
            `partial capture). Review before refunding this order again.`,
    }),
  });
}

export async function run() {
  let flagged = 0;
  for await (const order of recentlyRefundedOrders(LOOKBACK_HOURS)) {
    const intentId = intentIdOf(order);
    const charge = await getChargeForIntent(intentId);
    const wooIntended = wooIntendedRefundMinor(order);
    const stripeRefunded = stripeRefundedMinor(charge);
    const [action, reason, overRefundMinor] = decide(order, charge, wooIntended, stripeRefunded);
    if (action === "orphan") {
      console.warn(`Order ${order.id} has a refund but no matching Stripe charge (${intentId})`);
      continue;
    }
    if (action === "skip" || action === "ok" || action === "underrefund") continue;
    console.warn(
      `Order ${order.id}: ${reason}. Woo intended ${wooIntended}c, Stripe refunded ${stripeRefunded}c. ` +
      `${DRY_RUN ? "would flag" : "flagging"}`
    );
    if (!DRY_RUN) await flag(order, reason, overRefundMinor);
    flagged++;
  }
  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
