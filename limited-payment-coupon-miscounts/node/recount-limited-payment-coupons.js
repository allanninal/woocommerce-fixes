/**
 * Recount and repair a WooCommerce Subscriptions coupon limited to N renewal payments.
 *
 * A coupon can be set to discount only a subscription's first N renewal payments
 * (the "Active for x payments" field WooCommerce Subscriptions adds to a coupon).
 * Each subscription keeps a running counter of how many payments that coupon has
 * already discounted, in item meta on the subscription. A failed-then-retried
 * renewal, or a plan switch, can make that counter skip a count or add one twice,
 * so the coupon keeps discounting past its real limit (a quiet revenue leak) or
 * stops discounting a payment early (a support ticket).
 *
 * This walks subscriptions carrying the coupon, recounts the payments it should
 * have discounted by looking at the subscription's own paid renewal order
 * history (each renewal order's line item carries a coupon snapshot, and its
 * PaymentIntent is confirmed against Stripe), compares that to the stored
 * counter, and repairs the counter when it disagrees. Read only by default.
 * Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/limited-payment-coupon-miscounts/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const COUPON_CODE = process.env.COUPON_CODE || "vip10";

const COUNTER_META_PREFIX = "_coupon_number_payments_";
const PAID_ORDER_STATUSES = new Set(["processing", "completed"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function storedCounter(subscription, couponCode) {
  const key = `${COUNTER_META_PREFIX}${couponCode.toLowerCase()}`;
  for (const meta of subscription.meta_data || []) {
    if (meta.key === key) {
      const n = parseInt(meta.value, 10);
      return Number.isNaN(n) ? null : n;
    }
  }
  return null;
}

export function orderAppliedCoupon(order, couponCode) {
  for (const line of order.coupon_lines || []) {
    if ((line.code || "").toLowerCase() === couponCode.toLowerCase()) return true;
  }
  return false;
}

export function truePaymentCount(renewalOrders, couponCode, verifiedIntentIds) {
  let count = 0;
  for (const order of renewalOrders) {
    if (!PAID_ORDER_STATUSES.has(order.status)) continue;
    if (!orderAppliedCoupon(order, couponCode)) continue;
    const intentId = intentIdOf(order);
    if (intentId !== null && !verifiedIntentIds.has(intentId)) continue;
    count++;
  }
  return count;
}

export function decide(subscription, couponCode, trueCount) {
  const stored = storedCounter(subscription, couponCode);
  if (stored === null) return ["unknown", "no stored counter found for this coupon"];
  if (stored === trueCount) return ["skip", "counter already matches the real payment count"];
  const direction = stored > trueCount ? "ahead of" : "behind";
  return ["repair", `stored counter (${stored}) is ${direction} the real count (${trueCount})`];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

function renewalOrderIds(subscription) {
  return subscription.renewal_order_ids || [];
}

async function* subscriptionsWithCoupon(couponCode) {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) {
      const codes = new Set((sub.coupon_lines || []).map((l) => (l.code || "").toLowerCase()));
      if (codes.has(couponCode.toLowerCase())) yield sub;
    }
    page++;
  }
}

async function getRenewalOrders(subscription) {
  return Promise.all(renewalOrderIds(subscription).map((id) => woo(`/orders/${id}`)));
}

async function verifyIntents(intentIds) {
  const verified = new Set();
  for (const intentId of intentIds) {
    let intent;
    try {
      intent = await stripe.paymentIntents.retrieve(intentId);
    } catch {
      continue;
    }
    if (intent.status === "succeeded") verified.add(intentId);
  }
  return verified;
}

async function repairCounter(subscriptionId, couponCode, trueCount) {
  const key = `${COUNTER_META_PREFIX}${couponCode.toLowerCase()}`;
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key, value: String(trueCount) }] }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Coupon '${couponCode}' payment counter recounted from order history ` +
            `and corrected to ${trueCount}.`,
    }),
  });
}

export async function run(couponCode = COUPON_CODE) {
  let repaired = 0;
  for await (const subscription of subscriptionsWithCoupon(couponCode)) {
    const renewals = await getRenewalOrders(subscription);
    const intentIds = new Set(renewals.map(intentIdOf).filter(Boolean));
    const verified = await verifyIntents(intentIds);
    const trueCount = truePaymentCount(renewals, couponCode, verified);
    const [action, reason] = decide(subscription, couponCode, trueCount);
    if (action === "skip" || action === "unknown") {
      if (action === "unknown") console.warn(`Subscription ${subscription.id}: ${reason}`);
      continue;
    }
    console.log(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would repair" : "repairing"}`);
    if (!DRY_RUN) await repairCounter(subscription.id, couponCode, trueCount);
    repaired++;
  }
  console.log(`Done. ${repaired} subscription(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
