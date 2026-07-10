/**
 * Fix WooCommerce variable products whose price range and stock status went
 * stale after a variation was deleted.
 *
 * Deleting a variation removes that row, but nothing tells the parent product
 * to recompute its cached "_price", "_min_variation_price" / "_max_variation_price",
 * or "_stock_status". The parent keeps showing the old range (or "In stock"
 * when every remaining variation is out of stock) until something forces a
 * resync. Read only when DRY_RUN is true. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/deleting-a-variation-does-not-resync-the-parent/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const IN_STOCK = "instock";
const OUT_OF_STOCK = "outofstock";
const ON_BACKORDER = "onbackorder";

export function priceMinor(value) {
  if (value === null || value === undefined || value === "") return null;
  return Math.round(parseFloat(value) * 100);
}

export function expectedState(variations) {
  const purchasable = variations.filter(
    (v) => v.status === "publish" && priceMinor(v.price) !== null
  );
  if (purchasable.length === 0) {
    return { minPrice: null, maxPrice: null, stockStatus: OUT_OF_STOCK };
  }

  const prices = purchasable.map((v) => priceMinor(v.price));
  const statuses = new Set(purchasable.map((v) => v.stock_status));
  let stockStatus;
  if (statuses.has(IN_STOCK) || statuses.has(ON_BACKORDER)) {
    stockStatus = statuses.has(IN_STOCK) ? IN_STOCK : ON_BACKORDER;
  } else {
    stockStatus = OUT_OF_STOCK;
  }

  return { minPrice: Math.min(...prices), maxPrice: Math.max(...prices), stockStatus };
}

/**
 * Pure decision function. No I/O. Returns [action, reason, expected].
 *
 * action is one of:
 *   "skip"          - parent is not a variable product, or nothing is out of sync
 *   "no-variations" - all variations are gone, parent should show unpurchasable
 *   "fix"           - the cached parent values disagree with what the live variations say
 */
export function decide(parent, variations) {
  if (parent.type !== "variable") {
    return ["skip", "not a variable product", null];
  }

  const expected = expectedState(variations);

  if (variations.length === 0) {
    const alreadyCleared = parent.stock_status === OUT_OF_STOCK && (parent.price === null || parent.price === "");
    if (alreadyCleared) return ["skip", "already reflects no variations", expected];
    return ["no-variations", "every variation was deleted, parent still shows stale data", expected];
  }

  // The REST API exposes the parent's cached low price as "price". A healthy
  // variable product keeps "price" equal to the lowest live variation price.
  const cachedMin = priceMinor(parent.price);
  const cachedStatus = parent.stock_status;

  const mismatchedPrice = expected.minPrice !== null && cachedMin !== expected.minPrice;
  const mismatchedStock = cachedStatus !== expected.stockStatus;

  if (mismatchedPrice || mismatchedStock) {
    return ["fix", "parent price range or stock status is stale after a variation delete", expected];
  }

  return ["skip", "parent already matches its live variations", expected];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* getVariableProducts() {
  let page = 1;
  while (true) {
    const batch = await woo(`/products?type=variable&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const product of batch) yield product;
    page++;
  }
}

async function getVariations(productId) {
  const variations = [];
  let page = 1;
  while (true) {
    const batch = await woo(`/products/${productId}/variations?per_page=100&page=${page}`);
    if (!batch.length) break;
    variations.push(...batch);
    page++;
  }
  return variations;
}

/**
 * Force WooCommerce to recompute the parent by sending a zero-length variation
 * batch update. WooCommerce's variable product data store runs
 * WC_Product_Variable::sync on that call, which rebuilds price range and
 * stock status from the variations that still exist. We also PUT the
 * expected values directly so the storefront is correct right away.
 */
async function applyFix(productId, expected) {
  await woo(`/products/${productId}/variations/batch`, {
    method: "POST",
    body: JSON.stringify({ update: [] }),
  });

  const payload = { stock_status: expected.stockStatus };
  if (expected.minPrice !== null) {
    payload.regular_price = (expected.minPrice / 100).toFixed(2);
  }
  await woo(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function run() {
  let fixed = 0;
  for await (const product of getVariableProducts()) {
    const variations = await getVariations(product.id);
    const [action, reason, expected] = decide(product, variations);
    if (action === "skip") continue;
    console.log(`Product ${product.id}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await applyFix(product.id, expected);
    fixed++;
  }
  console.log(`Done. ${fixed} product(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
