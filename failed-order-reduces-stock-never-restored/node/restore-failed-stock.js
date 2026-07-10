/**
 * Restore stock for WooCommerce orders that reduced it and then failed or were cancelled.
 *
 * WooCommerce reduces stock as soon as an order is placed, before payment is confirmed.
 * When the order later moves to Failed or Cancelled, WooCommerce is supposed to add that
 * stock back automatically. That restore step can be skipped: a Stripe decline that lands
 * after a timeout, a status change made through the REST API or an import tool, a plugin
 * that short circuits the transition, or a restart mid request. The order is left holding
 * a `_reduced_stock` flag with no matching stock increase, and the product quietly sells
 * out early.
 *
 * This walks recent Failed and Cancelled orders, and for any order still flagged as having
 * reduced stock, adds each line item's quantity back to the matching product or variation
 * stock and clears the flag. Safe to run again and again. Read only for the Stripe
 * PaymentIntent id (order meta `_stripe_intent_id`, falling back to `transaction_id`), used
 * only to label the restock note. Dry run by default.
 *
 * Guide: https://www.allanninal.dev/woocommerce/failed-order-reduces-stock-never-restored/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const RESTOCK_STATUSES = new Set(["failed", "cancelled"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function reducedStockFlag(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_order_stock_reduced") return String(meta.value) === "1";
  }
  return false;
}

export function restockableItems(order) {
  const items = [];
  for (const item of order.line_items || []) {
    const productId = item.variation_id || item.product_id;
    const qty = item.quantity || 0;
    if (productId && qty > 0) items.push({ product_id: productId, quantity: qty });
  }
  return items;
}

export function decide(order) {
  if (!RESTOCK_STATUSES.has(order.status)) return ["skip", "order not failed or cancelled"];
  if (!reducedStockFlag(order)) return ["skip", "stock already restored or never reduced"];
  const items = restockableItems(order);
  if (items.length === 0) return ["skip", "no line items with stock to restore"];
  return ["restore", `stock reduced but never restored (${items.length} line item(s))`];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* failedOrCancelledOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=failed,cancelled&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function restoreStock(order, items, intentId) {
  for (const item of items) {
    const product = await woo(`/products/${item.product_id}`);
    if (product.manage_stock !== true) continue;
    const current = product.stock_quantity || 0;
    const newQty = current + item.quantity;
    await woo(`/products/${item.product_id}`, {
      method: "PUT",
      body: JSON.stringify({ stock_quantity: newQty }),
    });
  }
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: "_order_stock_reduced", value: "0" }] }),
  });
  let note = `Stock restored by restore-failed-stock. Order stayed ${order.status} with ` +
             `reduced stock never given back.`;
  if (intentId) note += ` Stripe PaymentIntent ${intentId}.`;
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export async function run() {
  let restored = 0;
  for await (const order of failedOrCancelledOrders()) {
    const [action, reason] = decide(order);
    if (action !== "restore") continue;
    const items = restockableItems(order);
    const intentId = intentIdOf(order);
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would restore" : "restoring"}`);
    if (!DRY_RUN) await restoreStock(order, items, intentId);
    restored++;
  }
  console.log(`Done. ${restored} order(s) ${DRY_RUN ? "to restore" : "restored"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
