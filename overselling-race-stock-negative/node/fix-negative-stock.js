/**
 * Find and correct WooCommerce products and variations that oversold to negative stock.
 *
 * Under a burst of concurrent orders, two checkouts can both pass the stock check and
 * each reduce stock, so the quantity falls below zero. Negative stock skews reports
 * and reorder math. This walks managed-stock products and variations, finds the ones
 * below zero, and sets them back to zero over the REST API. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/overselling-race-stock-negative/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function isOversold(item) {
  if (!item.manage_stock) return false;
  const q = item.stock_quantity;
  return q !== null && q !== undefined && q < 0;
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* products() {
  let page = 1;
  while (true) {
    const batch = await woo(`/products?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const product of batch) yield product;
    page++;
  }
}

async function* variations(productId) {
  let page = 1;
  while (true) {
    const batch = await woo(`/products/${productId}/variations?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const variation of batch) yield variation;
    page++;
  }
}

async function setStock(path) {
  await woo(path, { method: "PUT", body: JSON.stringify({ stock_quantity: 0 }) });
}

export async function run() {
  let fixed = 0;
  for await (const product of products()) {
    let targets = [[`/products/${product.id}`, product]];
    if (product.type === "variable") {
      targets = [];
      for await (const v of variations(product.id)) targets.push([`/products/${product.id}/variations/${v.id}`, v]);
    }
    for (const [path, item] of targets) {
      if (!isOversold(item)) continue;
      console.warn(`${path} is at ${item.stock_quantity}. ${DRY_RUN ? "would set to 0" : "setting to 0"}`);
      if (!DRY_RUN) await setStock(path);
      fixed++;
    }
  }
  console.log(`Done. ${fixed} oversold item(s) ${DRY_RUN ? "to correct" : "corrected"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
