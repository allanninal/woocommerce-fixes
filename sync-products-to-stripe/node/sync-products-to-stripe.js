/**
 * Create the missing Stripe Product and Price for WooCommerce products that are
 * billed through Stripe (usually WooCommerce Subscriptions) but have never been synced.
 *
 * A subscription product can be sold in WooCommerce for months before anyone notices
 * that Stripe has no matching Product or Price behind it, usually because it was
 * imported, duplicated, or created before the store gateway was switched on. This
 * walks WooCommerce products, checks the saved Stripe ids in product meta, and
 * creates whatever Stripe is missing, then writes the new ids back onto the product.
 * Read only by default until DRY_RUN is turned off. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/sync-products-to-stripe/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || "usd";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const SYNCABLE_STATUSES = new Set(["publish"]);
const SYNCABLE_TYPES = new Set(["simple", "subscription", "variable-subscription"]);

export function stripeIdsOf(product) {
  let productId = null;
  let priceId = null;
  for (const meta of product.meta_data || []) {
    if (meta.key === "_stripe_product_id" && meta.value) productId = meta.value;
    if (meta.key === "_stripe_price_id" && meta.value) priceId = meta.value;
  }
  return [productId, priceId];
}

export function productAmountMinor(product) {
  const price = product.price || product.regular_price || "0";
  return Math.round(parseFloat(price) * 100);
}

/**
 * Pure decision: what does this WooCommerce product need in Stripe?
 * Returns [action, reason]. Action is one of:
 *   "skip"          - not something we sync (draft, unpriced, wrong type)
 *   "create_both"   - no Stripe product or price exists yet, make both
 *   "create_price"  - the Stripe product exists but the price is missing or stale
 *   "ok"             - already in sync, nothing to do
 */
export function decide(product, stripeProduct, stripePrice) {
  if (!SYNCABLE_STATUSES.has(product.status)) return ["skip", "product is not published"];
  if (!SYNCABLE_TYPES.has(product.type)) return ["skip", "product type is not billed through Stripe"];
  if (productAmountMinor(product) <= 0) return ["skip", "product has no price yet"];

  if (!stripeProduct) return ["create_both", "no Stripe product exists for this WooCommerce product"];
  if (stripeProduct.active === false) return ["create_both", "the saved Stripe product was archived"];

  if (!stripePrice) return ["create_price", "Stripe product exists but the price is missing"];
  if (stripePrice.active === false) return ["create_price", "the saved Stripe price was archived"];
  if (stripePrice.unit_amount !== productAmountMinor(product)) {
    return ["create_price", "WooCommerce price changed since the last sync"];
  }

  return ["ok", "already in sync"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getStripeProduct(productId) {
  if (!productId) return null;
  try {
    return await stripe.products.retrieve(productId);
  } catch {
    return null;
  }
}

async function getStripePrice(priceId) {
  if (!priceId) return null;
  try {
    return await stripe.prices.retrieve(priceId);
  } catch {
    return null;
  }
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

async function saveStripeIds(productId, stripeProductId, stripePriceId) {
  await woo(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "_stripe_product_id", value: stripeProductId },
        { key: "_stripe_price_id", value: stripePriceId },
      ],
    }),
  });
}

async function createStripeProductAndPrice(product) {
  const stripeProduct = await stripe.products.create({
    name: product.name,
    metadata: { woo_product_id: String(product.id) },
  });
  const stripePrice = await stripe.prices.create({
    product: stripeProduct.id,
    unit_amount: productAmountMinor(product),
    currency: DEFAULT_CURRENCY,
  });
  return [stripeProduct, stripePrice];
}

async function createStripePrice(stripeProductId, product) {
  return stripe.prices.create({
    product: stripeProductId,
    unit_amount: productAmountMinor(product),
    currency: DEFAULT_CURRENCY,
  });
}

export async function run() {
  let synced = 0;
  for await (const product of wooProducts()) {
    const [stripeProductId, stripePriceId] = stripeIdsOf(product);
    const stripeProduct = await getStripeProduct(stripeProductId);
    const stripePrice = await getStripePrice(stripePriceId);
    const [action, reason] = decide(product, stripeProduct, stripePrice);

    if (action === "skip" || action === "ok") continue;

    console.log(`Product ${product.id} (${product.name}): ${reason}. ${DRY_RUN ? "would sync" : "syncing"}`);
    if (!DRY_RUN) {
      if (action === "create_both") {
        const [newProduct, newPrice] = await createStripeProductAndPrice(product);
        await saveStripeIds(product.id, newProduct.id, newPrice.id);
      } else if (action === "create_price") {
        const newPrice = await createStripePrice(stripeProduct.id, product);
        await saveStripeIds(product.id, stripeProduct.id, newPrice.id);
      }
    }
    synced++;
  }
  console.log(`Done. ${synced} product(s) ${DRY_RUN ? "to sync" : "synced"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
