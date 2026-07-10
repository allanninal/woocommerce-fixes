/**
 * Backfill metadata.order_id on old Stripe PaymentIntents that predate it.
 *
 * Older orders, orders created through a custom checkout, or PaymentIntents
 * recreated during a gateway migration can succeed without ever getting
 * order_id written into their Stripe metadata. The payment is fine, only the
 * label that lets later scripts match the PaymentIntent back to its
 * WooCommerce order is missing.
 *
 * This script walks recent paid orders, reads the PaymentIntent id each
 * order already has saved (meta _stripe_intent_id, falling back to
 * transaction_id), fetches that PaymentIntent from Stripe, and writes
 * order_id onto its metadata when it is missing or wrong. It never touches
 * the charge, the amount, or the order status.
 *
 * Guide: https://www.allanninal.dev/woocommerce/backfill-order-id-metadata/
 *
 * Safe by default. Set DRY_RUN=false to actually write.
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 365);
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
 * order: a plain object with at least id and status.
 * intent: a plain object with at least id, status, and metadata, or null
 *   when Stripe has no matching PaymentIntent.
 *
 * Returns [action, reason]. action is one of:
 *   "skip"     - nothing to do, already correct or not worth touching
 *   "orphan"   - the saved intent id does not resolve in Stripe
 *   "backfill" - metadata.order_id is missing or wrong, write it
 */
export function decide(order, intent) {
  if (!intent) return ["orphan", "no matching PaymentIntent found in Stripe"];
  const existing = (intent.metadata || {}).order_id;
  const orderIdStr = String(order.id);
  if (existing === orderIdStr) return ["skip", "metadata.order_id already correct"];
  if (!["succeeded", "processing"].includes(intent.status)) {
    return ["skip", "intent not in a paid state, leave it alone"];
  }
  return ["backfill", "metadata.order_id missing or pointing at the wrong order"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
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

async function* paidOrders(lookbackDays) {
  const after = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function backfillMetadata(intentId, orderId) {
  await stripe.paymentIntents.update(intentId, {
    metadata: { order_id: String(orderId) },
  });
}

export async function run() {
  let fixed = 0;
  for await (const order of paidOrders(LOOKBACK_DAYS)) {
    if (!PAID_STATUSES.has(order.status)) continue;
    const intentId = intentIdOf(order);
    const intent = await getIntent(intentId);
    const [action, reason] = decide(order, intent);
    if (action === "orphan") {
      console.warn(`Order ${order.id}: ${reason} (intent id on order: ${intentId})`);
      continue;
    }
    if (action === "skip") continue;
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would backfill" : "backfilling"}`);
    if (!DRY_RUN) await backfillMetadata(intent.id, order.id);
    fixed++;
  }
  console.log(`Done. ${fixed} PaymentIntent(s) ${DRY_RUN ? "to backfill" : "backfilled"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
