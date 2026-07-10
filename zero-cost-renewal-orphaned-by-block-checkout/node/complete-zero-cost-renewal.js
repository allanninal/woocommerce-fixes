/**
 * Finish zero cost WooCommerce Subscriptions renewal orders orphaned by block checkout.
 *
 * When a renewal nets to $0.00 (a 100% off coupon, a switch credit, a free trial
 * that converted with a balance still applied) WooCommerce skips Stripe entirely,
 * since there is nothing to charge. The classic checkout flow still calls
 * `payment_complete()` on the order for a $0 total. The block checkout flow does
 * not run that step for zero cost renewals, so the renewal order is created and
 * then just sits on Pending or On hold, no Stripe PaymentIntent is ever attached,
 * no renewal note is added, and the subscription's next payment date is never
 * advanced.
 *
 * This script finds renewal orders that are genuinely zero cost, still unpaid,
 * and have no Stripe PaymentIntent on them (because none was ever needed), and
 * completes them the way `payment_complete()` would have. It never touches an
 * order that has a real PaymentIntent attached or a non-zero total, those belong
 * to a different fix. Read only in dry run. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/zero-cost-renewal-orphaned-by-block-checkout/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const UNPAID_STATUSES = new Set(["pending", "on-hold"]);
const ZERO_COST_TOLERANCE_MINOR = 1; // a cent of rounding slack

export function orderTotalMinor(order) {
  // Keep money math in minor units (cents).
  return Math.round(parseFloat(order.total) * 100);
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function isRenewalOrder(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_subscription_renewal" && meta.value) return true;
  }
  return false;
}

function createdVia(order) {
  return (order.created_via || "").toLowerCase();
}

export function decide(order) {
  /**
   * Pure decision: should this renewal order be completed as a zero cost renewal?
   * Returns a tuple of [action, reason]. No I/O, just the order object already on
   * hand, so this is trivial to unit test.
   */
  if (!isRenewalOrder(order)) return ["skip", "not a subscription renewal order"];
  if (!UNPAID_STATUSES.has(order.status)) return ["skip", "order is not pending or on-hold"];
  if (orderTotalMinor(order) > ZERO_COST_TOLERANCE_MINOR) return ["skip", "order total is not zero cost"];
  if (intentIdOf(order) !== null) {
    // A PaymentIntent exists, so this is a stuck payment case, not an orphaned
    // zero cost renewal. That belongs to the "paid orders stuck on pending" fix.
    return ["skip", "a Stripe PaymentIntent is attached, not a zero cost orphan"];
  }
  const via = createdVia(order);
  if (via !== "checkout" && via !== "subscription" && via !== "") {
    return ["review", "unexpected created_via, check manually"];
  }
  return ["complete", "zero cost renewal with no PaymentIntent, safe to complete"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* renewalOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=pending,on-hold&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function completeRenewal(order) {
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ status: "processing", set_paid: true }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Completed by the zero cost renewal script. This renewal totaled $0.00 " +
            "and had no Stripe PaymentIntent, so it was never finished by the block " +
            "checkout flow. Marked processing and paid.",
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const order of renewalOrders()) {
    const [action, reason] = decide(order);
    if (action === "review") { console.warn(`Order ${order.id}: ${reason}`); continue; }
    if (action !== "complete") continue;
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would complete" : "completing"}`);
    if (!DRY_RUN) await completeRenewal(order);
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to complete" : "completed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
