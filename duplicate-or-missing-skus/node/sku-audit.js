/**
 * Find duplicate and missing SKUs across WooCommerce products and variations.
 *
 * Two products can end up sharing one SKU, or having a blank one, after a CSV
 * import, a plugin sync, or two editors saving at the same time. WooCommerce
 * does not stop this at the database level, so the store ends up with broken
 * inventory sync, wrong analytics, and orders that point at the wrong item.
 *
 * This walks every product and variation, groups them by SKU, and reports
 * every group that is duplicated or blank. It never renames a SKU on its own.
 * For a product tied to a real paid order (checked against Stripe using the
 * PaymentIntent id saved on the order), it only flags the conflict for a
 * human to fix by hand, since renaming a SKU under a paid order can break
 * fulfillment and reporting. For a product with no paid order behind it, it
 * is safe to flag as auto-fixable, since nothing downstream depends on that
 * SKU yet.
 *
 * Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/duplicate-or-missing-skus/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const ORDER_LOOKBACK_DAYS = Number(process.env.ORDER_LOOKBACK_DAYS || 90);
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
 * Pure decision function. No I/O.
 *
 * sku: the SKU string, "" for blank.
 * entries: list of { productId, type: "product" | "variation" } sharing this SKU.
 * hasPaidOrder: true if any entry in this group is a line item on an order
 *   that Stripe confirms was actually paid (a succeeded PaymentIntent).
 *
 * Returns [action, reason]:
 *   "ok"           - a normal, unique, non-blank SKU. Nothing to do.
 *   "review"       - conflict exists, but a paid order depends on one of the
 *                    items, so a human must decide which SKU is authoritative.
 *   "auto_fixable" - conflict exists and no paid order depends on any item in
 *                    the group, so it is safe to assign new placeholder SKUs
 *                    automatically.
 */
export function decide(sku, entries, hasPaidOrder) {
  if (sku !== "" && entries.length === 1) return ["ok", "unique SKU"];
  const reason = sku === "" ? "missing SKU" : `SKU '${sku}' shared by ${entries.length} items`;
  if (hasPaidOrder) {
    return ["review", `${reason}, at least one item has a paid order behind it`];
  }
  return ["auto_fixable", `${reason}, no paid orders depend on these items yet`];
}

/** Pure. Groups a flat list of { id, sku, type } into a Map keyed by SKU. */
export function groupBySku(products) {
  const groups = new Map();
  for (const item of products) {
    const sku = (item.sku || "").trim();
    if (!groups.has(sku)) groups.set(sku, []);
    groups.get(sku).push({ productId: item.id, type: item.type || "product" });
  }
  return groups;
}

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
    const batch = await woo(`/products?per_page=100&page=${page}&status=any`);
    if (!batch.length) return;
    for (const product of batch) {
      yield { id: product.id, sku: product.sku || "", type: "product" };
      if (product.type === "variable") {
        yield* variationsOf(product.id);
      }
    }
    page++;
  }
}

async function* variationsOf(productId) {
  let page = 1;
  while (true) {
    const batch = await woo(`/products/${productId}/variations?per_page=100&page=${page}`);
    if (!batch.length) return;
    for (const variation of batch) {
      yield { id: variation.id, sku: variation.sku || "", type: "variation" };
    }
    page++;
  }
}

async function* paidOrdersRecent() {
  const after = new Date(Date.now() - ORDER_LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function stripeConfirmsPaid(order) {
  const intentId = intentIdOf(order);
  if (!intentId) return false;
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    return intent.status === "succeeded";
  } catch {
    return false;
  }
}

async function productIdsWithPaidOrders() {
  const ids = new Set();
  for await (const order of paidOrdersRecent()) {
    if (!(await stripeConfirmsPaid(order))) continue;
    for (const line of order.line_items || []) {
      const pid = line.variation_id || line.product_id;
      if (pid) ids.add(pid);
    }
  }
  return ids;
}

function noteOnProducts(entries, message) {
  for (const entry of entries) {
    console.log(`Would tag product ${entry.productId} (${entry.type}): ${message}`);
  }
}

export async function run() {
  const products = [];
  for await (const item of allProducts()) products.push(item);
  const groups = groupBySku(products);
  const paidIds = await productIdsWithPaidOrders();

  let toReview = 0;
  let toAutofix = 0;
  for (const [sku, entries] of groups) {
    const hasPaidOrder = entries.some((e) => paidIds.has(e.productId));
    const [action, reason] = decide(sku, entries, hasPaidOrder);
    if (action === "ok") continue;
    console.warn(
      `${action === "review" ? "REVIEW" : "AUTO-FIXABLE"}: ${reason} -> [${entries.map((e) => e.productId).join(", ")}]`
    );
    if (!DRY_RUN) noteOnProducts(entries, reason);
    if (action === "review") toReview++;
    else toAutofix++;
  }

  console.log(
    `Done. ${toReview} SKU conflict(s) need review, ${toAutofix} SKU conflict(s) safe to auto-fix.` +
    (DRY_RUN ? " (dry run, nothing written)" : "")
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
