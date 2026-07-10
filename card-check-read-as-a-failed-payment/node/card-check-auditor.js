/**
 * Fix subscriptions dunned for a zero amount Stripe card check, not a real failed renewal.
 *
 * Stripe sometimes verifies a saved card with a $0 PaymentIntent, for example after a
 * card updater event or a trial signup. If that check does not come back clean, some
 * failure handling treats it exactly like a declined renewal charge. This walks recently
 * dunned subscriptions, reads the PaymentIntent behind the last order, and reactivates
 * any subscription whose "failure" was really a zero amount check.
 *
 * Guide: https://www.allanninal.dev/woocommerce/card-check-read-as-a-failed-payment/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 3);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const FAILED_STATUSES = new Set(["on-hold", "pending-cancel"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision: should a dunned subscription be restored because the "failed"
 * intent behind it was really a zero amount card check?
 *
 * subscription: object with at least a `status` property.
 * intent: a Stripe PaymentIntent-like object (or null/undefined if there was
 *   nothing to check), read for `amount` (minor units) and `status`.
 * Returns a [action, reason] tuple. action is one of "restore" or "skip".
 */
export function decide(subscription, intent) {
  if (!FAILED_STATUSES.has(subscription.status)) return ["skip", "subscription is not in a dunned state"];
  if (!intent) return ["skip", "no Stripe intent to check"];
  if ((intent.amount || 0) === 0) return ["restore", "the failed intent was a zero amount card check"];
  if (intent.status === "succeeded") return ["skip", "the intent actually succeeded, nothing to fix"];
  return ["skip", "a real charge was attempted and declined"];
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

async function getOrder(orderId) {
  if (!orderId) return null;
  return woo(`/orders/${orderId}`);
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function* heldSubscriptions() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=on-hold,pending-cancel&modified_after=${after}&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function restore(subscriptionId, intent) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "active" }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Reactivated by the card check auditor. PaymentIntent ${intent.id} ` +
            `had amount 0, a card check, not a failed renewal. No dunning is owed here.`,
    }),
  });
}

export async function run() {
  let restored = 0;
  for await (const subscription of heldSubscriptions()) {
    const orderId = subscription.last_order_id || subscription.last_order;
    const order = await getOrder(orderId);
    const intent = order ? await getIntent(intentIdOf(order)) : null;
    const [action, reason] = decide(subscription, intent);
    if (action !== "restore") continue;
    console.log(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would restore" : "restoring"}`);
    if (!DRY_RUN) await restore(subscription.id, intent);
    restored++;
  }
  console.log(`Done. ${restored} subscription(s) ${DRY_RUN ? "to restore" : "restored"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
