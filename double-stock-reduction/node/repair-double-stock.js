/**
 * Find WooCommerce orders where stock was reduced more than once, and add the
 * extra units back. Read only in dry run. Safe to run again and again, since it
 * only ever restores the amount above a single clean reduction.
 *
 * Guide: https://www.allanninal.dev/woocommerce/double-stock-reduction/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const STOCK_REDUCED_STATUSES = ["processing", "completed", "on-hold"];

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

export function orderExpectedQty(order) {
  // Total units this order should have removed from stock, once.
  return (order.line_items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

export function recordedReducedQty(order) {
  // Total units actually removed from stock for this order, from meta.
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stock_reduced_qty" && meta.value) return Number(meta.value);
  }
  return null;
}

/**
 * Pure decision function. No I/O. Returns [action, reason, extraUnits].
 *
 * action is one of:
 *   "orphan" - the order could not be found
 *   "skip"   - nothing to do
 *   "review" - looks off but is not a clean multiple, needs a human
 *   "fix"    - stock was reduced more than once, extraUnits should be restored
 */
export function decide(order, expectedQty, recordedQty) {
  if (!order) return ["orphan", "order not found", 0];
  if (!STOCK_REDUCED_STATUSES.includes(order.status)) {
    return ["skip", "order not in a stock-reduced state", 0];
  }
  if (!expectedQty) return ["skip", "order has no line item quantity", 0];
  if (recordedQty === null || recordedQty === undefined) {
    return ["skip", "no recorded reduction to compare", 0];
  }
  if (recordedQty <= expectedQty) return ["skip", "reduction matches or is under the order total", 0];
  if (recordedQty % expectedQty !== 0) return ["review", "reduction is extra but not a clean multiple", 0];
  const times = recordedQty / expectedQty;
  if (times < 2) return ["skip", "reduction matches the order total", 0];
  const extraUnits = expectedQty * (times - 1);
  return ["fix", `stock reduced ${times}x for one order`, extraUnits];
}

async function* candidateOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(
      `/orders?status=${STOCK_REDUCED_STATUSES.join(",")}&after=${after}&per_page=50&page=${page}`
    );
    if (!batch || !batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function restoreStock(order, extraUnits) {
  for (const item of order.line_items || []) {
    const productId = item.product_id;
    const qty = Number(item.quantity) || 0;
    if (!productId || !qty) continue;
    const product = await woo(`/products/${productId}`);
    if (!product.manage_stock) continue;
    const current = Number(product.stock_quantity) || 0;
    const addBack = qty; // this line's share of one extra full reduction
    await woo(`/products/${productId}`, {
      method: "PUT",
      body: JSON.stringify({ stock_quantity: current + addBack }),
    });
  }
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Stock repair: ${extraUnits} extra unit(s) were removed by a duplicate ` +
            `reduction and have been added back. First reduction was left in place.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const order of candidateOrders()) {
    const expectedQty = orderExpectedQty(order);
    const recordedQty = recordedReducedQty(order);
    const [action, reason, extraUnits] = decide(order, expectedQty, recordedQty);
    if (action === "orphan") { console.warn("Order missing while checking stock reduction"); continue; }
    if (action === "skip" || action === "review") {
      if (action === "review") console.warn(`Order ${order.id}: ${reason}, needs a human look`);
      continue;
    }
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would restore" : "restoring"} ${extraUnits} unit(s)`);
    if (!DRY_RUN) await restoreStock(order, extraUnits);
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
