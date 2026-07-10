/**
 * Reconcile product stock after an order was edited in the WooCommerce admin.
 *
 * WooCommerce reduces stock once, when an order first moves to a stock reducing
 * status, and stamps how much it took on each line item in `_reduced_stock` meta.
 * If a shop manager later edits the order (changes a quantity, removes a line,
 * adds a new line) WooCommerce does not revisit that stock. This walks recent
 * orders, compares each line item's current quantity against its
 * `_reduced_stock` meta, and restocks or further reduces the difference so the
 * product stock matches what the order actually charged for.
 *
 * Read only by default (DRY_RUN=true). Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/order-edits-do-not-adjust-stock/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const STOCK_REDUCED_STATUSES = new Set(["processing", "completed", "on-hold"]);

export function reducedStockOf(lineItem) {
  for (const meta of lineItem.meta_data || []) {
    if (meta.key === "_reduced_stock") {
      const n = parseInt(meta.value, 10);
      return Number.isNaN(n) ? 0 : n;
    }
  }
  return 0;
}

export function lineItemsNeedingSync(order) {
  if (!STOCK_REDUCED_STATUSES.has(order.status)) return [];
  const out = [];
  for (const item of order.line_items || []) {
    if (!item.product_id) continue;
    const reduced = reducedStockOf(item);
    const current = Number(item.quantity || 0);
    if (reduced !== current) {
      out.push({
        product_id: item.product_id,
        variation_id: item.variation_id || 0,
        sku: item.sku || "",
        reduced,
        current,
        delta: current - reduced,
      });
    }
  }
  return out;
}

export function decide(order, product) {
  if (!STOCK_REDUCED_STATUSES.has(order.status)) return ["skip", "order not in a stock reducing status"];
  if (!product) return ["orphan", "product for this line item no longer exists"];
  if (!product.manage_stock) return ["unmanaged", "product does not manage stock"];
  return ["adjust", "line item quantity no longer matches reduced stock"];
}

export function applyDelta(currentStock, delta) {
  return Math.max(0, Number(currentStock) + Number(delta));
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

async function* recentOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed,on-hold&after=${after}&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function setStock(productId, newQty) {
  await woo(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({ stock_quantity: newQty, manage_stock: true }),
  });
}

async function addNote(orderId, note) {
  await woo(`/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ note }) });
}

export async function run() {
  let fixed = 0;
  for await (const order of recentOrders()) {
    const items = lineItemsNeedingSync(order);
    for (const item of items) {
      const product = await woo(`/products/${item.product_id}`);
      const [action] = decide(order, product);
      if (action === "skip" || action === "orphan" || action === "unmanaged") {
        if (action === "orphan") console.warn(`Order ${order.id} product ${item.product_id} missing`);
        continue;
      }
      const newQty = applyDelta(product.stock_quantity || 0, item.delta);
      console.log(
        `Order ${order.id} product ${item.product_id}: reduced=${item.reduced} current=${item.current} ` +
        `delta=${item.delta > 0 ? "+" : ""}${item.delta} -> stock ${newQty}. ${DRY_RUN ? "would fix" : "fixing"}`
      );
      if (!DRY_RUN) {
        await setStock(item.product_id, newQty);
        await addNote(
          order.id,
          `Stock reconciled for product #${item.product_id}: order edit changed the quantity from ` +
          `${item.reduced} to ${item.current}, stock adjusted by ${item.delta > 0 ? "+" : ""}${item.delta} to ${newQty}.`
        );
      }
      fixed++;
    }
  }
  console.log(`Done. ${fixed} line item(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
