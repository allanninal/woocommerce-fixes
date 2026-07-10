/**
 * Find WooCommerce orders where the stored tax total does not match the tax you
 * get from re-adding the line item taxes, the same math the frontend cart used.
 *
 * The checkout page rounds tax per line item as the buyer shops. The order that
 * gets saved can end up with a total_tax that was rounded a different way, so the
 * two numbers can disagree by a cent or two. This walks recent orders, recomputes
 * the expected tax from the saved line items in integer cents, and flags or fixes
 * any order whose stored total_tax drifts from that recomputed value. Safe by
 * default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/order-tax-off-by-a-cent-frontend-vs-api/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const MAX_DRIFT_CENTS = Number(process.env.MAX_DRIFT_CENTS || 3);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Orders in these statuses are still moving. Only reconcile settled money.
const SETTLED_STATUSES = new Set(["processing", "completed", "on-hold"]);

/** Turn a WooCommerce money string like "12.345" into integer cents, rounding
 * half away from zero the same way most tax engines do. */
export function toMinor(amount) {
  const cents = parseFloat(amount) * 100;
  return cents >= 0 ? Math.floor(cents + 0.5) : -Math.floor(-cents + 0.5);
}

/** Sum the per-rate tax entries on one line item, in cents. WooCommerce stores
 * this per item as taxes.total, an object of rate_id -> amount. */
export function lineItemTaxMinor(item) {
  const taxes = (item.taxes && item.taxes.total) || {};
  let total = 0;
  for (const amount of Object.values(taxes)) {
    if (amount !== null && amount !== undefined && amount !== "") total += toMinor(amount);
  }
  return total;
}

/** Recompute the order tax by re-adding every line item's own tax, the same
 * rounded-per-line approach the cart and checkout page use while shopping.
 * Covers line_items, shipping_lines, and fee_lines, since all three can carry tax. */
export function expectedTaxMinor(order) {
  let total = 0;
  for (const item of order.line_items || []) total += lineItemTaxMinor(item);
  for (const item of order.shipping_lines || []) total += lineItemTaxMinor(item);
  for (const item of order.fee_lines || []) total += lineItemTaxMinor(item);
  return total;
}

export function storedTaxMinor(order) {
  return toMinor(order.total_tax || "0");
}

/** Pure decision: compare the stored tax total against the tax recomputed
 * from the order's own line items. No network calls, no Stripe involved,
 * this is purely a WooCommerce order math question. */
export function decide(order, maxDriftCents = MAX_DRIFT_CENTS) {
  if (!SETTLED_STATUSES.has(order.status)) return ["skip", "order not settled yet"];
  const expected = expectedTaxMinor(order);
  const stored = storedTaxMinor(order);
  const drift = stored - expected;
  if (drift === 0) return ["ok", "tax matches the line items"];
  if (Math.abs(drift) > maxDriftCents) {
    return ["review", `tax off by ${drift} cents, too large to auto fix`];
  }
  return ["fix", `tax off by ${drift} cents, adjusting total_tax to ${expected}`];
}

export function minorToAmount(minor) {
  const sign = minor < 0 ? "-" : "";
  minor = Math.abs(minor);
  const whole = Math.floor(minor / 100);
  const frac = String(minor % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* recentOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed,on-hold&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

/** Set total_tax to the recomputed value and leave a note explaining why.
 * We only touch the order-level total_tax field, never the line items
 * themselves, so refunds and reports that read line item tax are unaffected. */
async function applyFix(order, expectedMinor) {
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ total_tax: minorToAmount(expectedMinor) }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Tax reconciler: stored total_tax did not match the sum of the " +
            "line item taxes. Adjusted total_tax to match the line items.",
    }),
  });
}

export async function run() {
  let fixed = 0;
  let flagged = 0;
  for await (const order of recentOrders()) {
    const [action, reason] = decide(order);
    if (action === "skip" || action === "ok") continue;
    if (action === "review") {
      console.warn(`Order ${order.id}: ${reason}. Needs a human look.`);
      flagged++;
      continue;
    }
    const expected = expectedTaxMinor(order);
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await applyFix(order, expected);
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to fix" : "fixed"}, ${flagged} flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
