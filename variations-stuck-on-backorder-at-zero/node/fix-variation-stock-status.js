/**
 * Repair WooCommerce variations whose stock_status disagrees with their stock_quantity.
 *
 * A variation can end up showing "On backorder" in the shop while its stock is at or
 * below zero and backorders are turned off. WooCommerce only recalculates
 * stock_status when the quantity changes through its own save path. A CSV import, a
 * direct database edit, or flipping the backorders setting after the quantity was
 * already low can leave the stored stock_status stale. This walks the variations of
 * a product (or every variable product), works out what stock_status should be from
 * the quantity and the backorders setting, and corrects any variation that
 * disagrees. Read only by default. Run it by hand or on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/variations-stuck-on-backorder-at-zero/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const PRODUCT_IDS = (process.env.PRODUCT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const VALID_STATUSES = new Set(["instock", "outofstock", "onbackorder"]);

/**
 * Work out the stock_status a variation should have.
 *
 * Only variations with manage_stock on carry their own quantity, so anything
 * else is left to WooCommerce and skipped. Backorders "yes" or "notify" both
 * mean the shop should keep selling once stock runs out.
 */
export function expectedStockStatus(variation) {
  if (!variation.manage_stock) return null;
  const qty = variation.stock_quantity;
  if (qty === null || qty === undefined) return null;
  const backorders = variation.backorders || "no";
  if (qty > 0) return "instock";
  if (backorders === "yes" || backorders === "notify") return "onbackorder";
  return "outofstock";
}

/**
 * Pure decision: does this variation's stock_status need to change.
 * Returns ["skip" | "fix", reason]. No I/O happens in here, so it is safe
 * and cheap to unit test.
 */
export function decide(variation) {
  const expected = expectedStockStatus(variation);
  if (expected === null) return ["skip", "variation does not manage its own stock"];
  const current = variation.stock_status;
  if (!VALID_STATUSES.has(current)) {
    return ["fix", `stock_status ${JSON.stringify(current)} is not a recognized value`];
  }
  if (current === expected) return ["skip", "stock_status already matches quantity and backorders"];
  return ["fix", `stock_status is ${JSON.stringify(current)} but should be ${JSON.stringify(expected)}`];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* listVariableProducts() {
  let page = 1;
  while (true) {
    const batch = await woo(`/products?type=variable&per_page=50&page=${page}&status=publish`);
    if (!batch.length) return;
    for (const product of batch) yield product;
    page++;
  }
}

async function* listVariations(productId) {
  let page = 1;
  while (true) {
    const batch = await woo(`/products/${productId}/variations?per_page=100&page=${page}`);
    if (!batch.length) return;
    for (const variation of batch) yield variation;
    page++;
  }
}

async function applyFix(productId, variationId, expectedStatus) {
  await woo(`/products/${productId}/variations/${variationId}`, {
    method: "PUT",
    body: JSON.stringify({ stock_status: expectedStatus }),
  });
}

async function targetProductIds() {
  if (PRODUCT_IDS.length) return PRODUCT_IDS;
  const ids = [];
  for await (const product of listVariableProducts()) ids.push(product.id);
  return ids;
}

export async function run() {
  let fixed = 0;
  for (const productId of await targetProductIds()) {
    for await (const variation of listVariations(productId)) {
      const [action, reason] = decide(variation);
      if (action === "skip") continue;
      const expected = expectedStockStatus(variation);
      console.log(
        `Variation ${variation.id} (product ${productId}): ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`
      );
      if (!DRY_RUN) await applyFix(productId, variation.id, expected);
      fixed++;
    }
  }
  console.log(`Done. ${fixed} variation(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
