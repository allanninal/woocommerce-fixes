/**
 * Find (and optionally trash) WooCommerce product variations whose parent product
 * is gone or is no longer a variable product.
 *
 * A variation is a real "product_variation" post of its own. When its parent product
 * is deleted, trashed, or its type is changed from variable to simple, WooCommerce
 * does not always clean up the child variations first. The orphan keeps its own row
 * in wp_posts and its own entry in the product lookup table, so it can still surface
 * in search, in stock reports, or on old cart and order line items, even though there
 * is no parent to load it under.
 *
 * This walks a list of known variation ids (for example gathered from order line
 * items, a stock export, or the wp_postmeta table) and checks each one's parent
 * through the WooCommerce REST API. Read only by default. Run on a schedule or ad
 * hoc after a product cleanup.
 *
 * Guide: https://www.allanninal.dev/woocommerce/orphaned-product-variations/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Variation ids to check. In practice this list comes from somewhere that still
// remembers old variation ids: an export, a lookup table dump, or order line items.
const CANDIDATE_IDS_ENV = process.env.CANDIDATE_VARIATION_IDS || "";

export function candidateIds() {
  return CANDIDATE_IDS_ENV.split(",").map((v) => v.trim()).filter(Boolean).map(Number);
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

export async function getRecordFor(id) {
  return woo(`/products/${id}`);
}

/**
 * Pure decision: given a variation record and its claimed parent record (or null
 * if the lookup failed), decide what to do.
 *
 * variation: an object with at least "id" and "parent_id".
 * parent: the parent product object, or null if it no longer exists.
 */
export function decide(variation, parent) {
  if (!variation) return ["skip", "variation itself no longer exists"];
  const parentId = variation.parent_id;
  if (!parentId) return ["skip", "not a variation, no parent_id set"];
  if (!parent) return ["orphan", "parent product no longer exists"];
  if (parent.status === "trash") return ["orphan", "parent product is trashed"];
  if (parent.type !== "variable") return ["orphan", "parent product is no longer a variable product"];
  return ["ok", "parent exists and is still variable"];
}

async function trashVariation(variationId) {
  await woo(`/products/${variationId}?force=false`, { method: "DELETE" });
}

export async function run() {
  let orphaned = 0;
  for (const variationId of candidateIds()) {
    const variation = await getRecordFor(variationId);
    const parent = variation && variation.parent_id ? await getRecordFor(variation.parent_id) : null;
    const [action, reason] = decide(variation, parent);
    if (action !== "orphan") continue;
    console.warn(`Variation ${variationId}: ${reason}. ${DRY_RUN ? "would trash" : "trashing"}`);
    if (!DRY_RUN) await trashVariation(variationId);
    orphaned++;
  }
  console.log(`Done. ${orphaned} orphaned variation(s) ${DRY_RUN ? "found" : "trashed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
