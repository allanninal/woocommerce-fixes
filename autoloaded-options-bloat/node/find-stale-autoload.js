/**
 * Find stale, oversized autoloaded wp_options rows left behind by Stripe order
 * processing, and report which ones are safe to demote to autoload='no'.
 *
 * WooCommerce Stripe gateways write small per-order records while a payment is in
 * flight: an idempotency lock, a processing flag, a cached PaymentIntent snapshot.
 * Some of these are saved with autoload left at the default of "yes", so every
 * single page load, including the storefront, pulls them into the alloptions
 * cache. Once the order is finished they serve no purpose, but nothing ever
 * cleans them up, so the autoloaded payload only grows.
 *
 * This reads a custom, read-only endpoint you add to your store
 * (wp-json/wc-tools/v1/autoloaded-options) that lists autoloaded options above a
 * size threshold, matches the Stripe-related ones back to their order through the
 * order id encoded in the option name, checks the order and its Stripe
 * PaymentIntent are both finished, and reports (or repairs) the ones safe to
 * demote. Read only by default.
 *
 * Guide: https://www.allanninal.dev/woocommerce/autoloaded-options-bloat/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const MIN_BYTES = Number(process.env.MIN_BYTES || 10000);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Matches option names such as _wc_stripe_idempotency_1042 or
// _wc_stripe_intent_1042, where the trailing digits are the WooCommerce order id.
const ORDER_OPTION_RE = /^_wc_stripe_(?:idempotency|intent|lock)_(\d+)$/;

const FINISHED_ORDER_STATUSES = new Set(["processing", "completed", "refunded", "cancelled", "failed"]);
const FINISHED_INTENT_STATUSES = new Set(["succeeded", "canceled"]);

/** Pull the WooCommerce order id out of a Stripe-related option name, or null. */
export function orderIdFromOption(optionName) {
  const match = ORDER_OPTION_RE.exec(optionName);
  return match ? Number(match[1]) : null;
}

/** The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id. */
export function intentIdOf(order) {
  for (const meta of (order && order.meta_data) || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order && order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision: what to do with one autoloaded option row.
 *
 * option is an object with at least option_name and bytes.
 * order is the matching WooCommerce order object, or null if not found.
 * intent is the matching Stripe PaymentIntent object, or null if not found.
 *
 * Returns [action, reason]. action is one of:
 *   "skip"   - leave it alone, not ours or below the size threshold
 *   "keep"   - it is ours, but the order or intent is still active
 *   "orphan" - it is ours, but the order no longer exists
 *   "demote" - it is ours, the order and the intent are both finished
 */
export function decide(option, order, intent) {
  if ((option.bytes || 0) < MIN_BYTES) return ["skip", "below the size threshold"];
  const orderId = orderIdFromOption(option.option_name);
  if (orderId === null) return ["skip", "not a Stripe order option"];
  if (!order) return ["orphan", `order ${orderId} no longer exists`];
  if (!FINISHED_ORDER_STATUSES.has(order.status)) return ["keep", "order is still active"];
  if (intent && !FINISHED_INTENT_STATUSES.has(intent.status)) {
    return ["keep", "Stripe PaymentIntent is still active"];
  }
  return ["demote", "order and PaymentIntent are both finished"];
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

async function autoloadedOptions(minBytes) {
  const res = await fetch(
    `${WOO_URL}/wp-json/wc-tools/v1/autoloaded-options?min_bytes=${minBytes}`,
    { headers: { Authorization: AUTH } },
  );
  if (!res.ok) throw new Error(`autoloaded-options returned ${res.status}`);
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

async function demoteOption(optionName) {
  const res = await fetch(`${WOO_URL}/wp-json/wc-tools/v1/autoloaded-options/demote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH },
    body: JSON.stringify({ option_name: optionName }),
  });
  if (!res.ok) throw new Error(`demote ${optionName} returned ${res.status}`);
}

export async function run() {
  let demoted = 0;
  let totalBytes = 0;
  for (const option of await autoloadedOptions(MIN_BYTES)) {
    const orderId = orderIdFromOption(option.option_name);
    const order = orderId !== null ? await woo(`/orders/${orderId}`) : null;
    const intent = order ? await getIntent(intentIdOf(order)) : null;
    const [action, reason] = decide(option, order, intent);
    if (action === "skip" || action === "keep") continue;
    if (action === "orphan") console.warn(`${option.option_name}: ${reason}`);
    console.log(
      `${option.option_name} (${option.bytes || 0} bytes): ${reason}. ` +
      `${DRY_RUN ? "would demote" : "demoting"}`,
    );
    if (!DRY_RUN) await demoteOption(option.option_name);
    demoted++;
    totalBytes += option.bytes || 0;
  }
  console.log(
    `Done. ${demoted} option(s) ${DRY_RUN ? "to demote" : "demoted"}, ` +
    `freeing about ${Math.round(totalBytes / 1024)} KB from every page load.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
