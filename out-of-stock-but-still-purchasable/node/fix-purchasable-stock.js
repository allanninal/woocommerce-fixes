/**
 * Repair WooCommerce products that are out of stock but still purchasable,
 * and check whether any order already slipped through while the catalog
 * was wrong.
 *
 * A product can end up with stock_status = "outofstock" while purchasable
 * stays true and catalog_visibility still lists it in the shop, so the buy
 * button keeps working. This happens most often on variable products, where
 * a variation sells out but the parent's stock_status is never resynced, or
 * a stock import writes the quantity but not the status. Two things need
 * fixing:
 *
 * 1. The product itself: lock stock_status, backorders, and
 *    catalog_visibility so a sold out item cannot be bought again.
 * 2. Any order placed for that product while it was broken: WooCommerce
 *    always creates the order once checkout completes, so we cross check
 *    the order's saved Stripe PaymentIntent (from order meta
 *    "_stripe_intent_id" or transaction_id) to see whether the buyer was
 *    actually charged. A real charge needs a human decision (fulfil from
 *    backorder or refund), so this only flags it, it never cancels or
 *    refunds by itself.
 *
 * Safe by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/out-of-stock-but-still-purchasable/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const SAFE_VISIBILITY = "search";
const OPEN_ORDER_STATUSES = new Set(["pending", "processing", "on-hold"]);

export function isOutOfStock(product) {
  if (product.stock_status === "outofstock") return true;
  if (!product.manage_stock) return false;
  const qty = product.stock_quantity;
  if (qty === null || qty === undefined) return false;
  return qty <= 0 && (product.backorders || "no") === "no";
}

export function decideProduct(product) {
  if (!isOutOfStock(product)) return ["skip", "product is in stock"];

  const purchasable = product.purchasable ?? true;
  const visibility = product.catalog_visibility ?? "visible";

  if (!purchasable && visibility === SAFE_VISIBILITY) {
    return ["skip", "already locked down: not purchasable and hidden from the shop"];
  }

  return ["repair", "out of stock but still purchasable or still fully listed"];
}

export function buildPatch() {
  return {
    stock_status: "outofstock",
    backorders: "no",
    catalog_visibility: SAFE_VISIBILITY,
  };
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function decideOrder(order, intent, repairedProductIds) {
  if (!OPEN_ORDER_STATUSES.has(order.status)) return ["skip", "order is not open"];

  const lineIds = new Set((order.line_items || []).map((item) => item.product_id));
  const touchesRepaired = [...repairedProductIds].some((id) => lineIds.has(id));
  if (!touchesRepaired) return ["skip", "order does not include a repaired product"];

  if (intent && intent.status === "succeeded") {
    return ["flag_charged", "buyer was charged while the item was out of stock"];
  }

  return ["flag_uncharged", "order is open but no succeeded charge is on file"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* listProducts() {
  let page = 1;
  while (true) {
    const batch = await woo(`/products?per_page=50&page=${page}&status=publish`);
    if (!batch.length) return;
    for (const product of batch) yield product;
    page++;
  }
}

async function* listVariations(productId) {
  let page = 1;
  while (true) {
    const batch = await woo(`/products/${productId}/variations?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const variation of batch) yield variation;
    page++;
  }
}

async function* recentOpenOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=pending,processing,on-hold&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
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

async function repairProduct(productId, patch) {
  await woo(`/products/${productId}`, { method: "PUT", body: JSON.stringify(patch) });
}

async function repairVariation(productId, variationId, patch) {
  const variationPatch = { stock_status: patch.stock_status, backorders: patch.backorders };
  await woo(`/products/${productId}/variations/${variationId}`, {
    method: "PUT",
    body: JSON.stringify(variationPatch),
  });
}

async function flagOrder(order, reason) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Out of stock check: ${reason}. This order includes a product that ` +
            `was out of stock but still purchasable. Please review.`,
    }),
  });
}

export async function run() {
  const repairedIds = new Set();

  for await (const product of listProducts()) {
    const [action, reason] = decideProduct(product);
    if (action === "repair") {
      console.warn(`Product ${product.id} (${product.name || ""}): ${reason}. ${DRY_RUN ? "would repair" : "repairing"}`);
      if (!DRY_RUN) await repairProduct(product.id, buildPatch());
      repairedIds.add(product.id);
    }

    if (product.type === "variable") {
      for await (const variation of listVariations(product.id)) {
        const [vAction, vReason] = decideProduct(variation);
        if (vAction !== "repair") continue;
        console.warn(`Variation ${variation.id} of product ${product.id}: ${vReason}. ${DRY_RUN ? "would repair" : "repairing"}`);
        if (!DRY_RUN) await repairVariation(product.id, variation.id, buildPatch());
        repairedIds.add(product.id);
      }
    }
  }

  let flagged = 0;
  if (repairedIds.size) {
    for await (const order of recentOpenOrders()) {
      const intent = await getIntent(intentIdOf(order));
      const [action, reason] = decideOrder(order, intent, repairedIds);
      if (action !== "flag_charged" && action !== "flag_uncharged") continue;
      console.warn(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
      if (!DRY_RUN) await flagOrder(order, reason);
      flagged++;
    }
  }

  console.log(
    `Done. ${repairedIds.size} product/variation(s) ${DRY_RUN ? "to repair" : "repaired"}, ` +
    `${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
