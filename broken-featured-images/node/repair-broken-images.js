/**
 * Find and clear WooCommerce product featured images that point to a missing file.
 *
 * A product can end up with a featured image that 404s: the media file was deleted
 * from the uploads folder, lost in a migration, or never finished uploading.
 * WooCommerce still stores the attachment id on the product, so the storefront, the
 * cart, and the order emails for real paid orders all render a broken image icon
 * instead of the product photo.
 *
 * This walks products that appear on recent paid orders (verified against Stripe so
 * we only touch products real customers actually bought), checks whether each
 * product's featured image URL resolves, and clears the image reference on any
 * product whose file is missing. WooCommerce then falls back to the store
 * placeholder image instead of a broken icon. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/broken-featured-images/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision: should we clear this product's featured image reference?
 *
 * product: shaped like the WooCommerce product REST response, at least
 *   { id, images: [{ id, src }, ...] }
 * imageReachable: true/false when we checked the URL, null when the product has
 *   no featured image at all (nothing to do).
 * Returns [action, reason] where action is "skip" or "clear".
 */
export function decide(product, imageReachable) {
  const images = product.images || [];
  if (images.length === 0) return ["skip", "product has no featured image"];
  if (imageReachable === null || imageReachable === undefined) {
    return ["skip", "no reachability result to judge"];
  }
  if (imageReachable) return ["skip", "featured image resolves fine"];
  return ["clear", "featured image file is missing (404 or error)"];
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * True when Stripe confirms this order was really paid the amount on file.
 * Used to decide which products are worth checking.
 */
export function paymentConfirmed(order, intent) {
  if (!PAID_STATUSES.has(order.status)) return false;
  if (!intent || intent.status !== "succeeded") return false;
  return Math.abs(orderAmountMinor(order) - (intent.amount_received || 0)) <= 1;
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

async function* recentPaidOrders(lookbackHours) {
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(
      `/orders?status=processing,completed&after=${since}&per_page=50&page=${page}`
    );
    if (!batch || batch.length === 0) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function imageUrlReachable(url) {
  try {
    let res = await fetch(url, { method: "HEAD" });
    if (res.status === 405) res = await fetch(url, { method: "GET" });
    return res.status < 400;
  } catch {
    return false;
  }
}

async function clearFeaturedImage(productId) {
  await woo(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({ images: [] }),
  });
}

export async function run() {
  const checked = new Set();
  let cleared = 0;
  for await (const order of recentPaidOrders(LOOKBACK_HOURS)) {
    const intent = await getIntent(intentIdOf(order));
    if (!paymentConfirmed(order, intent)) continue;
    for (const lineItem of order.line_items || []) {
      const productId = lineItem.product_id;
      if (!productId || checked.has(productId)) continue;
      checked.add(productId);
      const product = await woo(`/products/${productId}`);
      if (!product) {
        console.warn(`Product ${productId} from order ${order.id} no longer exists`);
        continue;
      }
      const images = product.images || [];
      const reachable = images.length ? await imageUrlReachable(images[0].src) : null;
      const [action, reason] = decide(product, reachable);
      if (action === "skip") continue;
      console.warn(`Product ${productId}: ${reason}. ${DRY_RUN ? "would clear" : "clearing"}`);
      if (!DRY_RUN) await clearFeaturedImage(productId);
      cleared++;
    }
  }
  console.log(`Done. ${cleared} product(s) ${DRY_RUN ? "to clear" : "cleared"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
