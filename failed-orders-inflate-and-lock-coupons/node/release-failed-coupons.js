/**
 * Release coupon usage that failed WooCommerce orders should not be holding.
 *
 * WooCommerce increases a coupon's usage_count, and records the billing email under
 * used_by, the moment an order is placed with that coupon attached, before payment is
 * confirmed. When the order later fails (a declined card, an abandoned Stripe
 * PaymentIntent, a gateway error), WooCommerce is supposed to release that usage
 * back. A lot of failure paths never call it: the order goes straight from pending
 * to failed without passing through the cancelled transition, the store runs High
 * Performance Order Storage (HPOS) with a plugin that intercepts the status change,
 * or the failure happens on a redirect the customer never returns to. The coupon
 * then looks used up, or a single customer looks like they hit
 * usage_limit_per_user, when Stripe never took a payment. This walks recent failed
 * orders, checks the Stripe PaymentIntent tied to the order (if any), and for every
 * failed order still holding a coupon usage slot, removes that order's identity from
 * the coupon's used_by list and decrements usage_count by one. Safe to run again and
 * again. Read only until DRY_RUN is turned off.
 *
 * Guide: https://www.allanninal.dev/woocommerce/failed-orders-inflate-and-lock-coupons/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Statuses that mean the sale never actually happened, so any coupon usage tied to
// the order should have been released.
const RELEASABLE_STATUSES = new Set(["failed", "cancelled"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderCustomerKey(order) {
  const email = order.billing && order.billing.email;
  if (email) return email;
  return order.customer_id ? String(order.customer_id) : null;
}

/**
 * Pure decision: should this order's coupon usage be released?
 *
 * order  - a WooCommerce order object (status, coupon_lines, billing, meta_data, ...)
 * intent - the Stripe PaymentIntent object for this order, or null if there is none
 *          or it could not be found
 * coupon - the WooCommerce coupon object for one code on the order (used_by, usage_count)
 *
 * Returns [action, reason]. action is "skip" or "release".
 */
export function decide(order, intent, coupon) {
  if (!RELEASABLE_STATUSES.has(order.status)) {
    return ["skip", "order did not fail, usage is legitimate"];
  }
  if (intent && intent.status === "succeeded") {
    // Stripe disagrees with WooCommerce: the payment actually went through.
    // Do not touch the coupon. That is a different problem.
    return ["skip", "Stripe shows the payment succeeded, order status is wrong"];
  }
  const key = orderCustomerKey(order);
  if (!key) return ["skip", "no billing email or customer id to match against used_by"];
  const usedBy = coupon.used_by || [];
  if (!usedBy.includes(key)) return ["skip", "coupon usage already released for this order"];
  return ["release", "failed order still holding a coupon usage slot"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function* failedOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=failed,cancelled&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) {
      if (order.coupon_lines && order.coupon_lines.length) yield order;
    }
    page++;
  }
}

async function getCouponByCode(code) {
  const matches = await woo(`/coupons?code=${encodeURIComponent(code)}`);
  return matches[0] || null;
}

async function releaseUsage(coupon, key) {
  const usedBy = (coupon.used_by || []).filter((entry) => entry !== key);
  const newCount = Math.max(0, Number(coupon.usage_count || 0) - 1);
  await woo(`/coupons/${coupon.id}`, {
    method: "PUT",
    body: JSON.stringify({ used_by: usedBy, usage_count: newCount }),
  });
}

export async function run() {
  let released = 0;
  for await (const order of failedOrders()) {
    const intent = await getIntent(intentIdOf(order));
    for (const line of order.coupon_lines) {
      const coupon = await getCouponByCode(line.code);
      if (!coupon) {
        console.warn(`Order ${order.id} used coupon ${line.code} which no longer exists`);
        continue;
      }
      const [action, reason] = decide(order, intent, coupon);
      if (action === "skip") continue;
      const key = orderCustomerKey(order);
      console.log(`Order ${order.id} / coupon ${line.code}: ${reason}. ${DRY_RUN ? "would release" : "releasing"}`);
      if (!DRY_RUN) await releaseUsage(coupon, key);
      released++;
    }
  }
  console.log(`Done. ${released} coupon usage slot(s) ${DRY_RUN ? "to release" : "released"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
