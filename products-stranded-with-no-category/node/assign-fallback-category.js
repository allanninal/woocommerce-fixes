/**
 * Assign a fallback category to WooCommerce products that have no category at all.
 *
 * A product with an empty categories array cannot be found through category pages,
 * menu links, or any widget that filters by category. It still has a direct URL and
 * still shows in search, so it quietly keeps selling while being invisible everywhere
 * a browsing shopper would normally find it. This walks published products, flags the
 * ones with zero categories, and assigns a configured fallback category so the product
 * is reachable again. It also checks recent Stripe PaymentIntents so a product that is
 * actively selling gets called out with higher urgency in the log. Read only by
 * default until DRY_RUN is turned off. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/products-stranded-with-no-category/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const FALLBACK_CATEGORY_ID = Number(process.env.FALLBACK_CATEGORY_ID || 0);
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const SYNCABLE_STATUSES = new Set(["publish"]);

/** The WooCommerce order id a Stripe PaymentIntent was billed for, if any. */
export function orderIdOf(intent) {
  return (intent.metadata && intent.metadata.order_id) || null;
}

/** The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id. */
export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function hasCategory(product) {
  return Boolean(product.categories && product.categories.length);
}

/**
 * Pure decision: does this product need the fallback category assigned?
 * Returns [action, reason]. Action is one of:
 *   "skip"    - not something we touch (draft/private, or already has a category)
 *   "blocked" - stranded, but there is no fallback category configured to use
 *   "fix"     - stranded and needs the fallback category assigned
 * `recentlySold` only changes the log message, never the action itself, since a
 * stranded product needs fixing either way.
 */
export function decide(product, fallbackCategoryId, recentlySold) {
  if (!SYNCABLE_STATUSES.has(product.status)) return ["skip", "product is not published"];
  if (hasCategory(product)) return ["skip", "product already has at least one category"];
  if (!fallbackCategoryId) return ["blocked", "no FALLBACK_CATEGORY_ID configured"];
  if (recentlySold) return ["fix", "stranded with no category, and it has recent sales"];
  return ["fix", "stranded with no category"];
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

async function* wooProducts() {
  let page = 1;
  while (true) {
    const batch = await woo(`/products?status=publish&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const product of batch) yield product;
    page++;
  }
}

async function recentSucceededOrderIds() {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
  const orderIds = new Set();
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    if (intent.status === "succeeded") {
      const orderId = orderIdOf(intent);
      if (orderId) orderIds.add(orderId);
    }
  }
  return orderIds;
}

async function recentlySoldProductIds(orderIds) {
  const productIds = new Set();
  for (const orderId of orderIds) {
    const order = await woo(`/orders/${orderId}`);
    if (!order) continue;
    // Confirm the order's own saved PaymentIntent id is the one Stripe reported,
    // so we never trust an order id from metadata alone.
    if (!intentIdOf(order)) continue;
    for (const line of order.line_items || []) {
      if (line.product_id) productIds.add(line.product_id);
    }
  }
  return productIds;
}

async function assignFallbackCategory(productId, fallbackCategoryId) {
  await woo(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({ categories: [{ id: fallbackCategoryId }] }),
  });
}

export async function run() {
  let fixed = 0;
  let blocked = 0;
  const soldIds = await recentlySoldProductIds(await recentSucceededOrderIds());
  for await (const product of wooProducts()) {
    const recentlySold = soldIds.has(product.id);
    const [action, reason] = decide(product, FALLBACK_CATEGORY_ID, recentlySold);
    if (action === "skip") continue;
    if (action === "blocked") {
      console.warn(`Product ${product.id} (${product.name}): ${reason}`);
      blocked++;
      continue;
    }
    console.log(
      `Product ${product.id} (${product.name}): ${reason}. ` +
      `${DRY_RUN ? "would assign fallback category" : "assigning fallback category"}`
    );
    if (!DRY_RUN) await assignFallbackCategory(product.id, FALLBACK_CATEGORY_ID);
    fixed++;
  }
  console.log(`Done. ${fixed} product(s) ${DRY_RUN ? "to fix" : "fixed"}. ${blocked} blocked on missing config.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
