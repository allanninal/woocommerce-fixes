/**
 * Find and repair WooCommerce coupons whose usage_count was incremented
 * twice for the same paid order created through the REST API.
 *
 * When an order is created through POST /wp-json/wc/v3/orders with
 * coupon_lines already attached, and the same order is then updated again
 * through the REST API (a retry, a fulfillment step, or an integration that
 * both creates and later PUTs the order to a paid status), WooCommerce can
 * run its usage-count hook more than once for that one order. Each run
 * increases the coupon's usage_count, so a coupon a single buyer redeemed
 * once ends up counted twice, or more, and can hit its usage_limit long
 * before it should.
 *
 * This script treats Stripe as the source of truth for "was this order paid
 * exactly once." For each order that carries a coupon, it reads the saved
 * PaymentIntent id from order meta _stripe_intent_id (falling back to
 * transaction_id), confirms with Stripe that the PaymentIntent succeeded,
 * and counts the order only once no matter how many times WooCommerce
 * re-saved it. It compares that trustworthy count against each coupon's
 * usage_count and, when usage_count is inflated, lowers it back to the
 * correct number.
 *
 * Read only by default. Run on a schedule or by hand.
 *
 * Guide: https://www.allanninal.dev/woocommerce/coupon-usage-counted-twice-via-rest/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const COUPON_CODES = (process.env.COUPON_CODES || "").split(",").map((c) => c.trim()).filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const VALID_ORDER_STATUSES = new Set(["processing", "completed", "on-hold"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  // Keep money math in minor units (cents) to avoid float drift.
  return Math.round(parseFloat(order.total) * 100);
}

export function countsAsOneRealUse(order, intent) {
  if (!VALID_ORDER_STATUSES.has(order.status)) return false;
  if (!intent) return false;
  if (intent.status !== "succeeded") return false;
  if (Math.abs(orderAmountMinor(order) - (intent.amount_received || 0)) > 1) return false;
  return true;
}

export function decide(coupon, verifiedUseCount) {
  const usageCount = coupon.usage_count || 0;
  if (usageCount < 0) {
    return ["skip", "usage_count is already negative, needs manual review", usageCount];
  }
  if (verifiedUseCount > usageCount) {
    return ["skip", "usage_count is not inflated for this order set", usageCount];
  }
  if (verifiedUseCount === usageCount) {
    return ["skip", "usage_count matches the verified orders that used it", usageCount];
  }
  return [
    "fix",
    `usage_count ${usageCount} is higher than the ${verifiedUseCount} verified order(s) that used it`,
    verifiedUseCount,
  ];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* listOrdersUsingCoupon(code) {
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?page=${page}&per_page=100`);
    if (!batch.length) return;
    for (const order of batch) {
      const codes = new Set((order.coupon_lines || []).map((line) => line.code));
      if (codes.has(code)) yield order;
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

async function verifiedUseCountForCoupon(code) {
  const seenOrderIds = new Set();
  for await (const order of listOrdersUsingCoupon(code)) {
    if (seenOrderIds.has(order.id)) continue;
    const intent = await getIntent(intentIdOf(order));
    if (countsAsOneRealUse(order, intent)) seenOrderIds.add(order.id);
  }
  return seenOrderIds.size;
}

async function getCoupon(code) {
  const matches = await woo(`/coupons?code=${encodeURIComponent(code)}`);
  return matches[0] || null;
}

async function applyFix(coupon, correctedCount) {
  await woo(`/coupons/${coupon.id}`, {
    method: "PUT",
    body: JSON.stringify({ usage_count: correctedCount }),
  });
}

export async function run() {
  if (!COUPON_CODES.length) {
    console.warn("No COUPON_CODES set. Nothing to check.");
    return;
  }
  let fixed = 0;
  for (const code of COUPON_CODES) {
    const coupon = await getCoupon(code);
    if (!coupon) {
      console.warn(`Coupon ${code} not found`);
      continue;
    }
    const verifiedCount = await verifiedUseCountForCoupon(code);
    const [action, reason, correctedCount] = decide(coupon, verifiedCount);
    if (action === "skip") {
      console.log(`Coupon ${code}: ${reason}`);
      continue;
    }
    console.log(`Coupon ${code}: ${reason}. ${DRY_RUN ? "would set usage_count to " + correctedCount : "fixing"}`);
    if (!DRY_RUN) await applyFix(coupon, correctedCount);
    fixed++;
  }
  console.log(`Done. ${fixed} coupon(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
