/**
 * Detect and strip a non recurring coupon that got applied to a subscription renewal.
 *
 * WooCommerce Subscriptions only carries a coupon onto renewal orders when the
 * coupon is one of the recurring discount types (recurring_percent,
 * recurring_fixed_cart, recurring_fixed_product). A normal one time coupon
 * (percent, fixed_cart, fixed_product) should only ever discount the first,
 * parent order. If one is found sitting on a renewal, it is almost always a
 * leftover from a manual coupon add, an older Subscriptions version, or a
 * support agent applying a "first order only" code by hand. Left alone it
 * quietly discounts every future renewal forever.
 *
 * This walks the renewal orders on each subscription, finds coupons whose
 * discount type is not in the recurring set, removes the coupon line from the
 * order, and recalculates the order totals so the renewal charges the correct
 * amount next time. Safe by default. Run on a schedule or by hand against one
 * subscription.
 *
 * Guide: https://www.allanninal.dev/woocommerce/wrong-coupon-type-on-renewals/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_SUBSCRIPTIONS = Number(process.env.LOOKBACK_SUBSCRIPTIONS || 200);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// The only discount types WooCommerce Subscriptions will keep applying to renewals.
const RECURRING_TYPES = new Set(["recurring_percent", "recurring_fixed_cart", "recurring_fixed_product"]);

// Renewal orders carry a link back to the subscription and a flag showing they
// are a renewal, not the original purchase.
const RENEWAL_META_KEY = "_subscription_renewal";

export function isRenewalOrder(order) {
  return (order.meta_data || []).some((meta) => meta.key === RENEWAL_META_KEY);
}

export function moneyToMinor(amount) {
  return Math.round(parseFloat(amount) * 100);
}

export function badCouponsOnOrder(order, couponTypesByCode) {
  const bad = [];
  for (const line of order.coupon_lines || []) {
    const code = (line.code || "").toLowerCase();
    const discountType = couponTypesByCode[code];
    if (discountType !== undefined && !RECURRING_TYPES.has(discountType)) {
      bad.push(line);
    }
  }
  return bad;
}

/**
 * Pure decision function. No I/O.
 * Returns [action, reason, badCouponLines]. action is "skip" or "fix".
 */
export function decide(order, couponTypesByCode) {
  if (!isRenewalOrder(order)) {
    return ["skip", "not a renewal order", []];
  }
  if (["cancelled", "refunded", "failed", "trash"].includes(order.status)) {
    return ["skip", "order is not in a state worth editing", []];
  }
  const bad = badCouponsOnOrder(order, couponTypesByCode);
  if (bad.length === 0) {
    return ["skip", "no non recurring coupon on this renewal", []];
  }
  return ["fix", "a non recurring coupon is applied to a renewal", bad];
}

export function discountMinorOf(lines) {
  return lines.reduce((total, line) => total + moneyToMinor(line.discount || "0"), 0);
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

async function* getSubscriptions() {
  let page = 1;
  let seen = 0;
  while (seen < LOOKBACK_SUBSCRIPTIONS) {
    const batch = await woo(`/subscriptions?per_page=50&page=${page}&status=active`);
    if (!batch || !batch.length) return;
    for (const sub of batch) {
      seen++;
      yield sub;
    }
    page++;
  }
}

async function getRenewalOrders(subscriptionId) {
  const result = await woo(`/subscriptions/${subscriptionId}/orders?type=renewal`);
  return result || [];
}

async function getCouponTypes(codes) {
  const types = {};
  for (const code of codes) {
    const matches = await woo(`/coupons?code=${encodeURIComponent(code)}`);
    if (matches && matches.length) {
      types[code.toLowerCase()] = matches[0].discount_type;
    }
  }
  return types;
}

async function stripCoupon(orderId, badLines) {
  for (const line of badLines) {
    await woo(`/orders/${orderId}/coupons/${line.id}`, { method: "DELETE" });
  }
  const addedBack = discountMinorOf(badLines);
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Removed a non recurring coupon that had been applied to this renewal. " +
            `Restored ${(addedBack / 100).toFixed(2)} to the order total. Fixed by ` +
            "strip-bad-renewal-coupons.",
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const sub of getSubscriptions()) {
    const renewals = await getRenewalOrders(sub.id);
    if (!renewals.length) continue;
    const codes = new Set();
    for (const order of renewals) {
      for (const line of order.coupon_lines || []) {
        if (line.code) codes.add(line.code);
      }
    }
    if (!codes.size) continue;
    const couponTypesByCode = await getCouponTypes(codes);
    for (const order of renewals) {
      const [action, reason, badLines] = decide(order, couponTypesByCode);
      if (action === "skip") continue;
      const codesStr = badLines.map((l) => l.code || "?").join(", ");
      console.log(
        `Renewal order ${order.id} on subscription ${sub.id}: ${reason} (${codesStr}). ` +
        `${DRY_RUN ? "would fix" : "fixing"}`
      );
      if (!DRY_RUN) await stripCoupon(order.id, badLines);
      fixed++;
    }
  }
  console.log(`Done. ${fixed} renewal order(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
