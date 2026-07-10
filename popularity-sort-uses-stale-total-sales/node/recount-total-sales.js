/**
 * Recount WooCommerce's total_sales product meta from real, paid orders.
 *
 * The "Popularity" catalog sort orders products by the total_sales number
 * stored on each product. WooCommerce core only bumps that number through
 * its own order status hooks, so it drifts from reality whenever orders are
 * imported straight into the database, a status is changed by another
 * plugin or a direct SQL update, or a refund and cancellation never
 * decrements it back down. This walks paid orders in a lookback window,
 * sums real quantities per product (minus refunded quantities), compares
 * that to the stored total_sales, and corrects any product whose number is
 * wrong. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/popularity-sort-uses-stale-total-sales/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 365);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision: should we rewrite a product's total_sales meta?
 * stored: the value currently saved on the product (what Popularity sorts by).
 * real: the number we computed from real order line items and refunds.
 * Returns [action, reason] where action is "fix" or "skip".
 */
export function decide(storedTotalSales, realTotalSales) {
  const stored = Number.isFinite(Number(storedTotalSales)) ? Math.trunc(Number(storedTotalSales)) : 0;
  const real = Math.max(0, Math.trunc(realTotalSales || 0));
  if (stored === real) return ["skip", "total_sales already correct"];
  return ["fix", `stored ${stored}, real ${real}`];
}

/**
 * Quantity actually sold for one order line item, in whole units.
 * A negative qty on a refund line item cancels out units from the
 * original order line item for the same product.
 */
export function netQuantity(lineItem) {
  const qty = Number(lineItem && lineItem.quantity);
  return Number.isFinite(qty) ? Math.trunc(qty) : 0;
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

async function* paidOrders(afterIso) {
  let page = 1;
  while (true) {
    const batch = await woo(
      `/orders?status=processing,completed&after=${afterIso}&per_page=100&page=${page}`
    );
    if (!batch || !batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function refundLineItems(orderId) {
  const refunds = (await woo(`/orders/${orderId}/refunds`)) || [];
  const items = [];
  for (const refund of refunds) {
    for (const item of refund.line_items || []) items.push(item);
  }
  return items;
}

async function realSalesByProduct(lookbackDays) {
  const after = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const totals = new Map();
  for await (const order of paidOrders(after)) {
    for (const item of order.line_items || []) {
      if (!item.product_id) continue;
      totals.set(item.product_id, (totals.get(item.product_id) || 0) + netQuantity(item));
    }
    for (const item of await refundLineItems(order.id)) {
      if (!item.product_id) continue;
      // Refund line items carry a negative quantity already.
      totals.set(item.product_id, (totals.get(item.product_id) || 0) + netQuantity(item));
    }
  }
  return totals;
}

async function writeTotalSales(productId, realTotalSales) {
  await woo(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({ total_sales: String(realTotalSales) }),
  });
}

export async function run() {
  let fixed = 0;
  const totals = await realSalesByProduct(LOOKBACK_DAYS);
  for (const [productId, realTotalSales] of totals) {
    const product = await woo(`/products/${productId}`);
    if (!product) {
      console.warn(`Product ${productId} has sales but no longer exists, skipping`);
      continue;
    }
    const [action, reason] = decide(product.total_sales, realTotalSales);
    if (action === "skip") continue;
    console.log(`Product ${productId}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await writeTotalSales(productId, realTotalSales);
    fixed++;
  }
  console.log(`Done. ${fixed} product(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
