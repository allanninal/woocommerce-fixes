/**
 * Clear the WooCommerce Stripe checkout locks that are left behind as expired
 * transients in wp_options.
 *
 * Every time a shopper starts paying, the WooCommerce Stripe gateway writes a short
 * lived transient such as `_transient_wc_stripe_lock_pi_...` (plus its matching
 * `_transient_timeout_wc_stripe_lock_pi_...` row) to stop the same PaymentIntent from
 * being processed twice at once. The lock is supposed to delete itself, or expire and
 * get swept the next time WordPress asks for that exact key. In practice checkout is
 * interrupted a lot: a fatal error mid request, a webhook that times out, a customer
 * who closes the tab. Nothing ever asks for that one off key again, so the row just
 * sits in wp_options, almost always with autoload=yes, forever. On a busy store this
 * turns into tens of thousands of dead rows that WordPress loads into memory on every
 * single page view.
 *
 * We cannot run raw SQL against wp_options from a script that only has WooCommerce
 * REST API and Stripe API access, so this script does the next safest thing: it walks
 * orders whose PaymentIntent is done on Stripe (succeeded or canceled) but which still
 * carry the store's own `_stripe_checkout_lock` order meta flag, the same marker the
 * gateway used to guard against a double charge. If Stripe has already settled the
 * intent, that lock has no reason to still exist, so we clear the order meta and log
 * the matching transient key for the site's cleanup job (or wp cli) to sweep out of
 * wp_options in bulk. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/expired-transients-bloat-wp-options/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Stripe PaymentIntent statuses that mean the intent is fully done, so any lock that
// was guarding it can never be needed again.
const SETTLED_INTENT_STATUSES = new Set(["succeeded", "canceled"]);
const LOCK_META_KEY = "_stripe_checkout_lock";

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function lockValueOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === LOCK_META_KEY && meta.value) return meta.value;
  }
  return null;
}

export function transientKeyFor(intentId) {
  return `_transient_wc_stripe_lock_${intentId}`;
}

/**
 * Pure decision. No I/O. Returns [action, reason].
 *
 * order: the WooCommerce order object from the REST API.
 * intent: the Stripe PaymentIntent object for this order's saved id, or null if
 *   Stripe has no record of it (a bad id, a test/live key mismatch, or it was never
 *   created).
 */
export function decide(order, intent) {
  const lock = order ? lockValueOf(order) : null;
  if (!lock) return ["skip", "no checkout lock on this order, nothing to clear"];
  if (!intent) return ["skip", "no matching Stripe PaymentIntent, leave the lock alone"];
  if (!SETTLED_INTENT_STATUSES.has(intent.status)) {
    return ["skip", "PaymentIntent is still in progress, the lock may still be needed"];
  }
  return ["clear", `PaymentIntent is ${intent.status}, the lock is stale`];
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

async function* recentOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function clearLock(order) {
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: LOCK_META_KEY, value: "" }] }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Cleared a stale Stripe checkout lock left over from a finished payment. " +
            "The matching wp_options transient can now be purged.",
    }),
  });
}

export async function run() {
  let cleared = 0;
  for await (const order of recentOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action !== "clear") continue;
    const key = transientKeyFor(intentIdOf(order));
    console.log(`Order ${order.id}: ${reason}. transient key ${key}. ${DRY_RUN ? "would clear" : "clearing"}`);
    if (!DRY_RUN) await clearLock(order);
    cleared++;
  }
  console.log(`Done. ${cleared} order(s) ${DRY_RUN ? "to clear" : "cleared"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
