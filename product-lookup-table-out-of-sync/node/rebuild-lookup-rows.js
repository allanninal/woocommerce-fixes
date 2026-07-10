/**
 * Find WooCommerce products whose wp_wc_product_meta_lookup row has drifted
 * from the real product data, and repair them by resaving through the
 * REST API.
 *
 * Never writes to wp_wc_product_meta_lookup directly. Resaving a product
 * runs WooCommerce's own save path, which is what rebuilds that row. Run on
 * a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/product-lookup-table-out-of-sync/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const MIN_MISMATCHED_ORDERS = Number(process.env.MIN_MISMATCHED_ORDERS || 2);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function* recentPaidOrders(lookbackDays) {
  const after = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

export function orderLineFacts(order) {
  return (order.line_items || [])
    .filter((item) => item.product_id)
    .map((item) => {
      const quantity = item.quantity || 1;
      const unitMinor = Math.round(parseFloat(item.price || 0) * 100);
      const subtotal = item.subtotal !== undefined ? item.subtotal : item.total;
      const discounted = parseFloat(item.total || 0) !== parseFloat(subtotal || 0);
      return { productId: item.product_id, unitMinor, discounted, quantity };
    });
}

export function productPriceMinor(product) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since 50.00 is wrong for those.
  return Math.round(parseFloat(product.price) * 100);
}

/**
 * Pure decision function. No I/O.
 *
 * orderFacts: [{ orderTotalMinor, stripeAmountMinor, discounted }] for recent
 * paid orders that contained this product.
 *
 * Returns a [action, reason] tuple where action is one of
 * "resave", "ok", or "skip".
 */
export function decide(product, orderFacts, minMismatchedOrders = 2) {
  if (product.purchasable === false) return ["skip", "product is not purchasable"];
  if (orderFacts.length === 0) return ["skip", "no recent paid orders to compare against"];

  const currentPrice = productPriceMinor(product);
  const mismatched = orderFacts.filter(
    (f) =>
      !f.discounted &&
      Math.abs(f.orderTotalMinor - currentPrice) > 1 &&
      Math.abs(f.orderTotalMinor - f.stripeAmountMinor) <= 1
  );

  if (mismatched.length >= minMismatchedOrders) {
    return ["resave", "lookup price looks stale against confirmed Stripe charges"];
  }
  if (product.stock_status === "instock" && product.stock_quantity === 0) {
    return ["resave", "lookup shows in stock with zero quantity"];
  }
  return ["ok", "lookup data matches recent activity"];
}

async function resaveProduct(product) {
  // Sending the product's own current price and stock back through the
  // REST API forces WooCommerce to run its normal save path, which
  // rebuilds the wp_wc_product_meta_lookup row for this product.
  await woo(`/products/${product.id}`, {
    method: "PUT",
    body: JSON.stringify({
      regular_price: product.regular_price || product.price,
      stock_quantity: product.stock_quantity,
    }),
  });
}

async function collectOrderFactsByProduct() {
  const byProduct = new Map();
  for await (const order of recentPaidOrders(LOOKBACK_DAYS)) {
    const intent = await getIntent(intentIdOf(order));
    const stripeAmount = intent ? intent.amount_received : null;
    if (stripeAmount == null) continue;
    for (const fact of orderLineFacts(order)) {
      const list = byProduct.get(fact.productId) || [];
      list.push({
        orderTotalMinor: fact.unitMinor,
        stripeAmountMinor: Math.round(stripeAmount / Math.max(fact.quantity, 1)),
        discounted: fact.discounted,
      });
      byProduct.set(fact.productId, list);
    }
  }
  return byProduct;
}

export async function run() {
  let resaved = 0;
  const factsByProduct = await collectOrderFactsByProduct();
  for (const [productId, orderFacts] of factsByProduct) {
    const product = await woo(`/products/${productId}`);
    if (!product) {
      console.warn(`Product ${productId} from recent orders is missing now`);
      continue;
    }
    const [action, reason] = decide(product, orderFacts, MIN_MISMATCHED_ORDERS);
    if (action !== "resave") continue;
    console.log(`Product ${productId}: ${reason}. ${DRY_RUN ? "would resave" : "resaving"}`);
    if (!DRY_RUN) await resaveProduct(product);
    resaved++;
  }
  console.log(`Done. ${resaved} product(s) ${DRY_RUN ? "to resave" : "resaved"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
