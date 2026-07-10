/**
 * Recount WooCommerce coupon usage from real, paid orders and repair a wrong usage_count.
 *
 * WooCommerce tracks how many times a coupon was used with a single number,
 * usage_count, stored on the coupon itself. Two checkouts that apply the
 * same coupon at nearly the same moment can both read the old number and
 * both write back old_number + 1, so one use is lost. A cancelled, failed,
 * or refunded order can also fail to give its use back. Either way the
 * stored count drifts from reality, and a limited coupon can be used more
 * times than the shop owner intended, or looks used up when it still has
 * room.
 *
 * This script asks WooCommerce for orders that used the coupon, keeps only
 * the ones that are genuinely paid, and confirms "genuinely paid" against
 * Stripe by looking up the order's PaymentIntent (from order meta
 * _stripe_intent_id, or transaction_id when it looks like a PaymentIntent
 * id) and checking its status is succeeded. That real count is compared to
 * the coupon's stored usage_count, and the stored number is corrected when
 * it disagrees. Read only by default. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/coupon-usage-count-undercounts/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Orders in these statuses are worth checking with Stripe at all. Anything
// else (cancelled, failed, refunded, pending, trash) never counts as a use.
const CANDIDATE_STATUSES = new Set(["processing", "completed", "on-hold"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderCountsAsUsed(order, intent) {
  if (!CANDIDATE_STATUSES.has(order.status)) return false;
  if (!intent) return false;
  return intent.status === "succeeded";
}

export function decide(coupon, realCount) {
  const stored = Number(coupon.usage_count || 0);
  if (stored === realCount) return ["ok", "usage_count already matches real orders"];
  if (stored < realCount) return ["correct", `undercounted: stored ${stored}, real ${realCount}`];
  return ["correct", `overcounted: stored ${stored}, real ${realCount}`];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* listCoupons() {
  let page = 1;
  while (true) {
    const batch = await woo(`/coupons?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const coupon of batch) yield coupon;
    page++;
  }
}

async function* ordersUsing(couponCode) {
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=any&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) {
      const codes = new Set((order.coupon_lines || []).map((line) => line.code));
      if (codes.has(couponCode)) yield order;
    }
    page++;
  }
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function realUsageCount(couponCode) {
  let count = 0;
  for await (const order of ordersUsing(couponCode)) {
    if (!CANDIDATE_STATUSES.has(order.status)) continue;
    const intent = await getIntent(intentIdOf(order));
    if (orderCountsAsUsed(order, intent)) count++;
  }
  return count;
}

async function correctUsageCount(couponId, realCount) {
  await woo(`/coupons/${couponId}`, {
    method: "PUT",
    body: JSON.stringify({ usage_count: realCount }),
  });
}

export async function run() {
  let corrected = 0;
  for await (const coupon of listCoupons()) {
    const realCount = await realUsageCount(coupon.code);
    const [action, reason] = decide(coupon, realCount);
    if (action === "ok") continue;
    console.log(
      `Coupon ${coupon.code} (${coupon.id}): ${reason}. ${DRY_RUN ? "would correct" : "correcting"}`
    );
    if (!DRY_RUN) await correctUsageCount(coupon.id, realCount);
    corrected++;
  }
  console.log(`Done. ${corrected} coupon(s) ${DRY_RUN ? "to correct" : "corrected"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
