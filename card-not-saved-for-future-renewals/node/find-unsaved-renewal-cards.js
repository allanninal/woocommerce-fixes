/**
 * Find WooCommerce subscriptions whose first payment succeeded but never
 * saved a reusable card, so the next automatic renewal has nothing to charge.
 *
 * The initial order can be paid in full while the Stripe PaymentIntent behind
 * it was created without `setup_future_usage`. That happens when a checkout
 * plugin, a custom "buy now" button, or an older integration builds the
 * PaymentIntent by hand and forgets the flag. Stripe still takes the money,
 * WooCommerce still marks the order paid, and nobody notices until the
 * renewal date arrives with no saved card to charge.
 *
 * This walks active and on-hold subscriptions, reads the PaymentIntent id
 * from the parent order's meta (_stripe_intent_id, falling back to
 * transaction_id), and asks Stripe whether that PaymentIntent actually
 * attached a reusable PaymentMethod to a Customer. If it did not, there is
 * nothing to recover, so the subscription is flagged (and optionally put
 * on-hold) well before the renewal is due, so the shop can ask the customer
 * for a card while there is still time. Read only by default. Run on a
 * schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/card-not-saved-for-future-renewals/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DAYS_BEFORE_RENEWAL = Number(process.env.DAYS_BEFORE_RENEWAL || 3);
const REVIEW_HOLD = (process.env.REVIEW_HOLD || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ACTIVE_STATUSES = new Set(["active", "on-hold"]);

export function getMeta(record, key) {
  for (const m of (record && record.meta_data) || []) {
    if (m.key === key) return m.value;
  }
  return null;
}

export function intentIdOf(order) {
  const value = getMeta(order, "_stripe_intent_id");
  if (value) return value;
  const tid = order && order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function daysUntil(renewalDateGmt, now) {
  if (!renewalDateGmt) return null;
  const renewal = new Date(renewalDateGmt.endsWith("Z") ? renewalDateGmt : `${renewalDateGmt}Z`);
  return (renewal.getTime() - now.getTime()) / 86400000;
}

/**
 * Pure decision function. No I/O.
 *
 * subscription: object with at least id, status, payment_method,
 *               next_payment_date_gmt.
 * parentOrder: the subscription's original paid order object, or null.
 * intent: the Stripe PaymentIntent object the parent order paid with, or
 *         null if it could not be found on Stripe at all.
 * now: a Date, passed in so this stays pure.
 */
export function decide(subscription, parentOrder, intent, now) {
  if (!ACTIVE_STATUSES.has(subscription.status)) {
    return ["skip", "subscription is not active or on-hold"];
  }
  if (subscription.payment_method !== "stripe") {
    return ["skip", "subscription is not on the Stripe gateway"];
  }
  const remaining = daysUntil(subscription.next_payment_date_gmt, now);
  if (remaining !== null && remaining > DAYS_BEFORE_RENEWAL) {
    return ["skip", "next renewal is not due soon enough to act yet"];
  }
  if (!parentOrder) {
    return ["skip", "no parent order to check yet"];
  }
  if (!intent) {
    return ["skip", "parent order has no Stripe PaymentIntent to check"];
  }
  if (intent.status !== "succeeded") {
    return ["skip", "parent order payment was not a succeeded charge"];
  }
  if (intent.customer && intent.payment_method) {
    return ["ok", "a reusable card is already attached for renewals"];
  }
  return ["flag", "payment succeeded but no reusable card was saved for renewals"];
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

async function* activeSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,on-hold&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
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

async function flag(subscription, reason) {
  await woo(`/subscriptions/${subscription.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Renewal card check failed: ${reason}. The next automatic renewal ` +
            `will not have a card to charge. Please ask the customer to add a ` +
            `payment method before the renewal date.`,
    }),
  });
  if (REVIEW_HOLD) {
    await woo(`/subscriptions/${subscription.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "on-hold" }),
    });
  }
}

export async function run() {
  const now = new Date();
  let flagged = 0;
  for await (const subscription of activeSubscriptions()) {
    const parentOrder = await getOrder(subscription.parent_id);
    const intent = await getIntent(intentIdOf(parentOrder));
    const [action, reason] = decide(subscription, parentOrder, intent, now);
    if (action !== "flag") continue;
    console.warn(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) await flag(subscription, reason);
    flagged++;
  }
  console.log(`Done. ${flagged} subscription(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
