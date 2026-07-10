/**
 * Stop Stripe from billing a WooCommerce subscription that was already cancelled.
 *
 * Cancelling a WooCommerce Subscription only updates the order and the local
 * subscription post. It does not, by itself, guarantee the linked Stripe
 * Subscription object gets canceled too. If that second cancel call is skipped,
 * delayed, or lost, Stripe's billing cycle keeps running and the customer's card
 * is charged again on the next renewal date even though WooCommerce shows the
 * subscription as cancelled.
 *
 * This walks recently cancelled WooCommerce subscriptions, reads the saved
 * Stripe subscription id from meta, and cancels the Stripe side for any
 * subscription Stripe still shows as active, trialing, or past_due. Read only
 * by default (DRY_RUN). Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/stripe-bills-after-cancellation/
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

// WooCommerce Subscriptions statuses that mean "the shop owner considers this closed."
const CANCELLED_WOO_STATUSES = new Set(["cancelled", "pending-cancel", "expired"]);

// Stripe subscription statuses that mean Stripe will still try to bill it.
const STILL_BILLING_STRIPE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

/**
 * The saved Stripe Subscription id, from meta _stripe_subscription_id or
 * falling back to the _stripe_intent_id prefix used by some gateway versions.
 */
export function stripeSubIdOf(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_subscription_id" && meta.value) return meta.value;
  }
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && typeof meta.value === "string" && meta.value.startsWith("sub_")) {
      return meta.value;
    }
  }
  const tid = subscription.transaction_id;
  return tid && tid.startsWith("sub_") ? tid : null;
}

/**
 * Pure decision: does the Stripe side need to be canceled?
 *
 * wooSubscription    - the WooCommerce Subscriptions order-like object (has
 *                       "status" and "meta_data")
 * stripeSubscription - the Stripe Subscription object (or null if there is
 *                       no id saved, or Stripe has no record of it)
 *
 * Returns [action, reason]. action is one of:
 *   "cancel" - Woo is cancelled but Stripe is still set to bill, cancel it
 *   "skip"   - Woo subscription is not in a cancelled state, leave alone
 *   "ok"     - Stripe already agrees the subscription is over
 *   "orphan" - no Stripe subscription id was ever saved, cannot act
 */
export function decide(wooSubscription, stripeSubscription) {
  if (!CANCELLED_WOO_STATUSES.has(wooSubscription.status)) {
    return ["skip", "WooCommerce subscription is not cancelled"];
  }
  if (!stripeSubscription) {
    return ["orphan", "no Stripe subscription id saved on this subscription"];
  }
  if (STILL_BILLING_STRIPE_STATUSES.has(stripeSubscription.status)) {
    return ["cancel", "Woo is cancelled but Stripe would still bill it"];
  }
  return ["ok", "Stripe already shows this subscription as over"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getStripeSubscription(subId) {
  if (!subId) return null;
  try {
    return await stripe.subscriptions.retrieve(subId);
  } catch {
    return null;
  }
}

async function* cancelledWooSubscriptions() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const statuses = [...CANCELLED_WOO_STATUSES].join(",");
  let page = 1;
  while (true) {
    const batch = await woo(
      `/subscriptions?status=${statuses}&modified_after=${after}&per_page=50&page=${page}`
    );
    if (!batch.length) return;
    for (const subscription of batch) yield subscription;
    page++;
  }
}

async function cancelInStripe(wooSubscription, stripeSubscription) {
  await stripe.subscriptions.cancel(stripeSubscription.id);
  await woo(`/orders/${wooSubscription.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Stripe subscription ${stripeSubscription.id} was still ${stripeSubscription.status} ` +
            `after this subscription was cancelled in WooCommerce. Canceled it in Stripe so the ` +
            `customer is not billed again.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const wooSubscription of cancelledWooSubscriptions()) {
    const subId = stripeSubIdOf(wooSubscription);
    const stripeSubscription = await getStripeSubscription(subId);
    const [action, reason] = decide(wooSubscription, stripeSubscription);
    if (action === "orphan") {
      console.warn(`Subscription ${wooSubscription.id} has no saved Stripe subscription id`);
      continue;
    }
    if (action === "skip" || action === "ok") continue;
    console.log(`Subscription ${wooSubscription.id}: ${reason}. ${DRY_RUN ? "would cancel" : "canceling"}`);
    if (!DRY_RUN) await cancelInStripe(wooSubscription, stripeSubscription);
    fixed++;
  }
  console.log(`Done. ${fixed} subscription(s) ${DRY_RUN ? "to cancel in Stripe" : "canceled in Stripe"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
