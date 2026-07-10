/**
 * Recompute and repair WooCommerce product_visibility terms that have drifted
 * away from a product's own catalog_visibility, featured, and stock_status fields.
 *
 * WooCommerce decides what a shopper can see by querying a hidden taxonomy,
 * product_visibility, built from terms like exclude-from-search, exclude-from-catalog,
 * featured, and outofstock. Those terms are only ever recomputed when a product goes
 * through WooCommerce's normal save routine. An import, a bulk edit tool, or a direct
 * database write can change catalog_visibility, featured, or stock_status without
 * triggering that recompute, so the terms and the fields disagree and the storefront
 * follows the (wrong) terms.
 *
 * This walks every product through the WooCommerce REST API, computes the exact
 * term set the product's own fields imply, compares it to the terms actually
 * assigned, and repairs any product where they differ by re-saving its own fields,
 * which forces WooCommerce to rebuild the terms. Safe by default (dry run). Run
 * once after an import or bulk edit, or on a schedule as a safety net.
 *
 * Guide: https://www.allanninal.dev/woocommerce/product-visibility-terms-mis-assigned/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const VALID_CATALOG_VISIBILITY = new Set(["visible", "catalog", "search", "hidden"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* allProducts() {
  let page = 1;
  while (true) {
    const batch = await woo(`/products?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const product of batch) yield product;
    page++;
  }
}

/**
 * The product_visibility term slugs currently assigned to this product.
 *
 * The core REST API does not expose this taxonomy directly, since WooCommerce
 * treats it as internal. Most stores read it through a small custom endpoint, a
 * WP-CLI export, or a reporting plugin that lists wp_term_relationships for the
 * product_visibility taxonomy. This wraps whatever that source is behind one call
 * so the rest of the script does not need to know about it.
 */
export async function assignedVisibilityTerms(productId) {
  const res = await fetch(`${WOO_URL}/wp-json/custom/v1/product-visibility-terms/${productId}`, {
    headers: { Authorization: AUTH },
  });
  if (!res.ok) throw new Error(`visibility terms lookup returned ${res.status}`);
  const data = await res.json();
  return data.terms || [];
}

/**
 * The exact set of product_visibility term slugs WooCommerce should assign for
 * this product's catalog_visibility, featured, and stock_status fields.
 */
export function expectedTerms(product) {
  const visibility = product.catalog_visibility || "visible";
  const terms = new Set();
  if (visibility === "catalog" || visibility === "hidden") terms.add("exclude-from-search");
  if (visibility === "search" || visibility === "hidden") terms.add("exclude-from-catalog");
  if (product.featured) terms.add("featured");
  if (product.stock_status === "outofstock") terms.add("outofstock");
  return terms;
}

/**
 * Pure decision: given a product's own fields and its currently assigned
 * product_visibility term slugs, decide what to do.
 *
 * product: an object with at least catalog_visibility, featured, stock_status.
 * assignedTerms: an array of term slugs currently on the product, or null/undefined.
 *
 * No network calls happen in here, which is what makes it safe and easy to test.
 */
export function decide(product, assignedTerms) {
  const visibility = product.catalog_visibility || "visible";
  if (!VALID_CATALOG_VISIBILITY.has(visibility)) {
    return ["skip", "unrecognized catalog_visibility value"];
  }
  const expected = expectedTerms(product);
  const assigned = new Set(assignedTerms || []);
  const same = expected.size === assigned.size && [...expected].every((t) => assigned.has(t));
  if (same) return ["ok", "assigned terms match the product's own fields"];
  return ["repair", `expected ${[...expected].sort()} but found ${[...assigned].sort()}`];
}

/**
 * Re-save the product's own fields so WooCommerce's save routine rebuilds the
 * product_visibility terms from scratch. We never write taxonomy terms directly.
 */
async function resyncVisibility(product) {
  await woo(`/products/${product.id}`, {
    method: "PUT",
    body: JSON.stringify({
      catalog_visibility: product.catalog_visibility || "visible",
      featured: Boolean(product.featured),
      stock_status: product.stock_status || "instock",
    }),
  });
}

export async function run() {
  let repaired = 0;
  for await (const product of allProducts()) {
    const assigned = await assignedVisibilityTerms(product.id);
    const [action, reason] = decide(product, assigned);
    if (action !== "repair") continue;
    console.warn(`Product ${product.id}: ${reason}. ${DRY_RUN ? "would resync" : "resyncing"}`);
    if (!DRY_RUN) await resyncVisibility(product);
    repaired++;
  }
  console.log(`Done. ${repaired} product(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
