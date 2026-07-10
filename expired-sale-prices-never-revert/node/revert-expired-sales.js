/**
 * Revert WooCommerce sale prices whose sale window already ended.
 *
 * A scheduled sale finishes on paper, but the wc_scheduled_sales WP-Cron task
 * that should clear it never runs (WP-Cron disabled, no overnight traffic, a
 * migration, a plugin conflict). This walks every product WooCommerce
 * currently flags as on sale, compares its stored sale end date to now, and
 * clears the sale price (and sale dates) for any product whose sale window
 * has passed. Regular price is never touched. Safe by default. Run on a
 * schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/expired-sale-prices-never-revert/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/** Parse a WooCommerce *_gmt date string (naive, UTC) into a Date. */
export function parseGmt(value) {
  if (!value) return null;
  return new Date(value.endsWith("Z") ? value : `${value}Z`);
}

/** Pull the fields that matter for the decision out of a product payload. */
export function saleWindowOf(product) {
  return {
    salePrice: product.sale_price || "",
    regularPrice: product.regular_price || "",
    endsAt: parseGmt(product.date_on_sale_to_gmt),
  };
}

/**
 * Pure decision: should this product's sale price be reverted right now?
 * No I/O here on purpose, so this can be unit tested without a live store.
 */
export function decide(saleWindow, now) {
  if (!saleWindow.salePrice) return ["skip", "no sale price set"];
  if (!saleWindow.endsAt) return ["skip", "open-ended sale, no end date"];
  if (saleWindow.endsAt > now) return ["skip", "sale window still open"];
  return ["revert", "sale end date has passed"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* productsOnSale() {
  let page = 1;
  while (true) {
    const batch = await woo(`/products?on_sale=true&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const product of batch) yield product;
    page++;
  }
}

async function revertSale(productId) {
  await woo(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({ sale_price: "", date_on_sale_from: null, date_on_sale_to: null }),
  });
}

export async function run() {
  const now = new Date();
  let reverted = 0;
  for await (const product of productsOnSale()) {
    const window = saleWindowOf(product);
    const [action, reason] = decide(window, now);
    if (action !== "revert") continue;
    console.log(`Product ${product.id}: ${reason}. ${DRY_RUN ? "would revert" : "reverting"}`);
    if (!DRY_RUN) await revertSale(product.id);
    reverted++;
  }
  console.log(`Done. ${reverted} product(s) ${DRY_RUN ? "to revert" : "reverted"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
