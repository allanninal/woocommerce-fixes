/**
 * Recompute the on sale flag for WooCommerce products from their real prices.
 *
 * The on sale badge and strikethrough price come from a cached flag that only
 * updates when WooCommerce resaves the product, usually through the daily
 * wc_scheduled_sales cron. If that cron is missed, or prices are changed outside
 * the normal save path (a direct database edit or a bulk import), the flag goes
 * stale. This walks the catalog, recomputes whether each product should be on
 * sale right now, and corrects the ones that disagree. Safe to run again and
 * again. Read only when DRY_RUN is true. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/on-sale-flag-shows-products-not-on-sale/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/** Convert a decimal price string to integer cents. Empty, null, or undefined means no price set. */
export function toMinor(priceString) {
  if (priceString === null || priceString === undefined || priceString === "") return null;
  return Math.round(parseFloat(priceString) * 100);
}

/** True when now falls inside the sale date range. A missing bound means no limit on that side. */
export function withinSaleWindow(dateFrom, dateTo, now) {
  if (dateFrom && now < new Date(dateFrom)) return false;
  if (dateTo && now > new Date(dateTo)) return false;
  return true;
}

/** Pure: work out whether a product should currently be on sale from its own fields. */
export function shouldBeOnSale(product, now) {
  const regular = toMinor(product.regular_price);
  const sale = toMinor(product.sale_price);
  if (regular === null || sale === null) return false;
  if (sale >= regular) return false;
  return withinSaleWindow(product.date_on_sale_from, product.date_on_sale_to, now);
}

/** Pure decision function. No I/O. Returns [action, reason]. */
export function decide(product, now) {
  const expected = shouldBeOnSale(product, now);
  const actual = Boolean(product.on_sale);
  if (expected === actual) return ["skip", "on sale flag already matches the prices"];
  if (expected && !actual) return ["fix", "product should be on sale but the flag says no"];
  // actual on_sale is stuck true: past the sale window, or the sale price is no
  // longer below the regular price, but the cached flag was never recalculated.
  return ["fix", "sale price is stale and should be cleared"];
}

async function* allProducts() {
  let page = 1;
  while (true) {
    const res = await fetch(
      `${WOO_URL}/wp-json/wc/v3/products?per_page=50&page=${page}&status=publish`,
      { headers: { Authorization: AUTH } }
    );
    if (!res.ok) throw new Error(`Woo products page ${page} returned ${res.status}`);
    const batch = await res.json();
    if (!batch.length) return;
    for (const product of batch) yield product;
    page++;
  }
}

/**
 * Nudge WooCommerce to recompute _price and the lookup table by resaving the
 * sale price: keep it as-is when the product should be on sale, or clear it when
 * the sale is over. We never invent a new price.
 */
async function applyFix(productId, expectedOnSale, currentSalePrice) {
  const payload = expectedOnSale ? { sale_price: currentSalePrice } : { sale_price: "" };
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3/products/${productId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: AUTH },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Woo product ${productId} update returned ${res.status}`);
}

export async function run() {
  const now = new Date();
  let fixed = 0;
  for await (const product of allProducts()) {
    const [action, reason] = decide(product, now);
    if (action === "skip") continue;
    const expected = shouldBeOnSale(product, now);
    console.log(`Product ${product.id}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await applyFix(product.id, expected, product.sale_price);
    fixed++;
  }
  console.log(`Done. ${fixed} product(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
