/**
 * Find legacy wp_posts order rows that should have been removed after an HPOS cleanup.
 *
 * When a store turns on High-Performance Order Storage, WooCommerce copies every order
 * into the new custom tables and, once compatibility mode is turned off, is supposed to
 * remove the matching legacy shop_order post row. That cleanup step can be interrupted,
 * skipped for a subset of orders, or never run at all, leaving posts behind that still
 * carry an id the order remembers as `_legacy_order_id`. Those leftover rows can confuse
 * anything that still scans wp_posts directly, and they take up space for no reason.
 *
 * This script walks HPOS orders through the REST API, reads the legacy post id each
 * order remembers, and confirms with Stripe that the order is fully settled before
 * reporting the legacy row as safe to remove. It never deletes anything itself. Read
 * only by default. Run on a schedule or by hand after a cleanup.
 *
 * Guide: https://www.allanninal.dev/woocommerce/legacy-order-rows-survive-after-hpos-cleanup/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 90);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Statuses that mean Stripe has fully finished with the payment, so it is safe to
// consider the order settled and its legacy row a pure leftover.
const SETTLED_INTENT_STATUSES = new Set(["succeeded", "canceled"]);
// Order statuses that are still in play and should never be touched.
const OPEN_ORDER_STATUSES = new Set(["pending", "on-hold", "processing"]);

export function legacyPostIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_legacy_order_id" && meta.value) {
      const id = parseInt(meta.value, 10);
      return Number.isNaN(id) ? null : id;
    }
  }
  return null;
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision. No I/O. Returns [action, reason].
 *
 * order: the HPOS order object from the WooCommerce REST API.
 * legacyPost: an object like { id: 123, post_type: "shop_order" } if a wp_posts row
 *   with that id still exists, or null if it was already removed.
 * intent: the Stripe PaymentIntent object for this order's saved id, or null if there
 *   is no PaymentIntent to check (e.g. an offline payment method).
 */
export function decide(order, legacyPost, intent) {
  const legacyId = order ? legacyPostIdOf(order) : null;
  if (!legacyId) return ["skip", "order has no legacy post id, nothing to check"];
  if (!legacyPost) return ["clean", "legacy row already gone, nothing left to do"];
  if (!["shop_order", "shop_order_refund"].includes(legacyPost.post_type)) {
    return ["skip", "post id is reused by unrelated content, leave it alone"];
  }
  if (OPEN_ORDER_STATUSES.has(order.status)) {
    return ["skip", "order is still open, keep both rows until it settles"];
  }
  if (intent && !SETTLED_INTENT_STATUSES.has(intent.status)) {
    return ["skip", "Stripe still has the payment in progress"];
  }
  if (intent) {
    const received = intent.amount_received ?? intent.amount ?? 0;
    if (Math.abs(orderAmountMinor(order) - received) > 1) {
      return ["mismatch", "Stripe amount does not match the order, needs a human look"];
    }
  }
  return ["report", "HPOS order is settled and the legacy row is a safe cleanup candidate"];
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

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function getLegacyPost(postId) {
  return woo(`/orders/legacy-post/${postId}`);
}

async function* hposOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=50&page=${page}&orderby=date&order=asc`);
    if (!batch || !batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function report(order, legacyId, reason) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `HPOS cleanup check: legacy post ${legacyId} still exists (${reason}). ` +
            `Safe to remove with WooCommerce's own cleanup tool. Flagged, not deleted.`,
    }),
  });
}

export async function run() {
  let flagged = 0;
  for await (const order of hposOrders()) {
    const legacyId = legacyPostIdOf(order);
    if (!legacyId) continue;
    const legacyPost = await getLegacyPost(legacyId);
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, legacyPost, intent);
    if (action === "skip" || action === "clean") continue;
    if (action === "mismatch") {
      console.warn(`Order ${order.id}: ${reason}`);
      continue;
    }
    console.log(`Order ${order.id}: legacy post ${legacyId}. ${DRY_RUN ? "would report" : "reporting"}`);
    if (!DRY_RUN) await report(order, legacyId, reason);
    flagged++;
  }
  console.log(`Done. ${flagged} legacy row(s) ${DRY_RUN ? "to report" : "reported"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
