/**
 * Find and clear test mode Stripe PaymentIntent ids saved on live WooCommerce orders.
 *
 * A test id and a live id look identical, both start with pi_, so the only reliable
 * check is asking the live Stripe account to retrieve it. Run once after a migration,
 * then on a light schedule for a few weeks. Read only by default.
 *
 * Guide: https://www.allanninal.dev/woocommerce/remove-test-ids-from-live/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const REVIEW_HOLD = (process.env.REVIEW_HOLD || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed", "on-hold"]);

/** The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id. */
export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision function: no I/O, easy to unit test.
 * order: an object with at least `status`.
 * intentId: the id read off the order (or null).
 * intent: the object returned by a live-mode lookup for that id (or null if missing).
 */
export function decide(order, intentId, intent) {
  if (!intentId) return ["skip", "no Stripe id saved on this order"];
  if (!PAID_STATUSES.has(order.status)) {
    return ["skip", "order is not in a state that relies on this id"];
  }
  if (intent) return ["ok", "id resolves on the live Stripe account"];
  return ["clear", "id does not exist on the live Stripe account, likely test mode"];
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
  } catch (err) {
    if (err.code === "resource_missing") return null;
    throw err;
  }
}

async function* candidateOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed,on-hold&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function clearTestId(orderId, intentId) {
  // Money math note: this script does not compare amounts, it only clears a
  // reference that the live Stripe account cannot resolve. Any amount checks
  // that need it should keep totals in minor units (cents), not floats.
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({
      transaction_id: "",
      meta_data: [{ key: "_stripe_intent_id", value: "" }],
    }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Cleared Stripe id ${intentId}: it does not exist on the live Stripe account ` +
            `and is likely a test mode id. Please confirm this order was actually paid ` +
            `before shipping or renewing it.`,
    }),
  });
  if (REVIEW_HOLD) {
    await woo(`/orders/${orderId}`, { method: "PUT", body: JSON.stringify({ status: "on-hold" }) });
  }
}

export async function run() {
  let cleared = 0;
  for await (const order of candidateOrders()) {
    const intentId = intentIdOf(order);
    const intent = await getIntent(intentId);
    const [action, reason] = decide(order, intentId, intent);
    if (action !== "clear") continue;
    console.warn(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would clear" : "clearing"}`);
    if (!DRY_RUN) await clearTestId(order.id, intentId);
    cleared++;
  }
  console.log(`Done. ${cleared} order(s) ${DRY_RUN ? "to clear" : "cleared"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
