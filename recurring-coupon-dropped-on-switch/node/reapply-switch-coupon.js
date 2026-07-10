/**
 * Reapply a recurring coupon that a subscription switch dropped.
 *
 * When a customer switches a subscription (upgrade, downgrade, or a plan
 * change), WooCommerce Subscriptions builds a new set of line items for the
 * resulting subscription but does not carry over a recurring coupon that was
 * active on the old one. The switch order itself can look correct, since the
 * one-time proration is right, but every renewal after the switch bills the
 * full price. This walks recent switch orders, compares the recurring coupons
 * on the parent subscription before and after, and reapplies any recurring
 * coupon the switch dropped. It also cross-checks the Stripe PaymentIntent
 * tied to the switch order so we only touch subscriptions where the switch
 * itself actually succeeded. Safe by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/recurring-coupon-dropped-on-switch/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const SWITCH_ORDER_KEY = "_subscription_switch";
const RECURRING_COUPON_META = "_switch_recurring_coupons";

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function recurringCouponCodes(subscription) {
  return (subscription.coupon_lines || [])
    .map((line) => line.code)
    .filter(Boolean)
    .sort();
}

export function beforeCodesOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === RECURRING_COUPON_META && meta.value) return [...meta.value].sort();
  }
  return [];
}

export function decide(beforeCodes, afterCodes, switchIntent) {
  const afterSet = new Set(afterCodes);
  const dropped = beforeCodes.filter((code) => !afterSet.has(code)).sort();
  if (dropped.length === 0) return ["skip", "no coupon was dropped", dropped];
  if (!switchIntent) return ["skip", "no Stripe payment found for the switch order", dropped];
  if (switchIntent.status !== "succeeded") {
    return ["skip", "switch payment did not succeed, nothing to repair yet", dropped];
  }
  return ["reapply", "switch succeeded but a recurring coupon was dropped", dropped];
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

async function getSwitchIntent(order) {
  const intentId = intentIdOf(order);
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function* switchOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const order of batch) {
      if ((order.meta_data || []).some((m) => m.key === SWITCH_ORDER_KEY)) yield order;
    }
    page++;
  }
}

async function reapplyCoupons(subscriptionId, codes) {
  await woo(`/subscriptions/${subscriptionId}/coupons`, {
    method: "POST",
    body: JSON.stringify({ coupons: codes.map((code) => ({ code })) }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Reapplied recurring coupon(s) ${codes.join(", ")} that the last plan switch ` +
            `dropped. Applied by the coupon reconciler.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const order of switchOrders()) {
    const subscriptionId = order.subscription_renewal || order.id;
    const subscription = await woo(`/subscriptions/${subscriptionId}`);
    if (!subscription) {
      console.warn(`Switch order ${order.id} points to missing subscription ${subscriptionId}`);
      continue;
    }
    const before = beforeCodesOf(order);
    const after = recurringCouponCodes(subscription);
    const intent = await getSwitchIntent(order);
    const [action, reason, dropped] = decide(before, after, intent);
    if (action === "skip") continue;
    console.log(
      `Subscription ${subscriptionId}: ${reason} (${dropped.join(", ")}). ` +
      `${DRY_RUN ? "would reapply" : "reapplying"}`
    );
    if (!DRY_RUN) await reapplyCoupons(subscriptionId, dropped);
    fixed++;
  }
  console.log(`Done. ${fixed} subscription(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
