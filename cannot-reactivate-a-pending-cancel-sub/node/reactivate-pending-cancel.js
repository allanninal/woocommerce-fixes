/**
 * Restore a WooCommerce Subscription that is stuck on pending-cancel back to active.
 *
 * A subscription in pending-cancel status carries a scheduled "end" date (the date it
 * will fully cancel at the end of the paid term). WooCommerce Subscriptions will not
 * let you set status back to active while that end date is still on the subscription,
 * because the status machine treats "has a pending cancellation date" as a reason to
 * block a direct jump to active. The fix is not to force the status field. It is to
 * clear the scheduled end date first, confirm the saved payment method still works
 * with Stripe, and only then move the subscription to active, the same order a
 * support agent would do it by hand in wp-admin. Read only unless DRY_RUN=false.
 *
 * Guide: https://www.allanninal.dev/woocommerce/cannot-reactivate-a-pending-cancel-sub/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Statuses WooCommerce Subscriptions itself considers "still paying".
const REACTIVATABLE_FROM = new Set(["pending-cancel", "on-hold"]);
// Payment method statuses from Stripe that are safe to bill again.
const USABLE_CARD_STATUSES = new Set(["succeeded", "requires_capture"]);

export function intentIdOf(order) {
  for (const meta of (order || {}).meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = (order || {}).transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision function. No I/O. Returns [action, reason].
 *
 * subscription: { status, schedule_end } or null
 * lastOrder: order-like object with meta_data / transaction_id, or null
 * paymentMethod: { status } describing the saved Stripe payment method's last known
 *   usability, or null if there is nothing on file
 *
 * Actions:
 *   "skip"    - nothing to do, subscription is not in a blocked pending-cancel state
 *   "blocked" - it is pending-cancel but we cannot safely reactivate yet
 *   "repair"  - clear the scheduled end date and set the subscription back to active
 */
export function decide(subscription, lastOrder, paymentMethod) {
  if (!subscription) return ["skip", "subscription not found"];
  const status = subscription.status;
  if (!REACTIVATABLE_FROM.has(status)) {
    return ["skip", "subscription is not in a reactivatable state"];
  }
  if (status === "on-hold") {
    return ["skip", "on-hold is a separate case, not covered here"];
  }

  const intentId = intentIdOf(lastOrder);
  if (!intentId) {
    return ["blocked", "no saved PaymentIntent to confirm the card still works"];
  }

  if (!paymentMethod) {
    return ["blocked", "could not read the saved payment method from Stripe"];
  }

  if (!USABLE_CARD_STATUSES.has(paymentMethod.status)) {
    return ["blocked", "saved payment method is not currently usable"];
  }

  const scheduleEnd = subscription.schedule_end || "";
  if (!scheduleEnd) {
    return ["repair", "no leftover end date, just flip status to active"];
  }

  return ["repair", "leftover end date is blocking reactivation, clear it then activate"];
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

async function getSubscription(subscriptionId) {
  return woo(`/subscriptions/${subscriptionId}`);
}

async function getLastOrder(subscription) {
  const related = subscription.related_orders || [];
  const orderId = related.length ? related[related.length - 1] : subscription.last_order_id;
  if (!orderId) return null;
  return woo(`/orders/${orderId}`);
}

async function getPaymentMethod(intentId) {
  if (!intentId) return null;
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    return { status: intent.status, payment_method: intent.payment_method };
  } catch {
    return null;
  }
}

/**
 * Clear the scheduled end date, then move the subscription to active.
 *
 * Two writes on purpose. WooCommerce Subscriptions re-checks whether the status
 * change is allowed on every PUT, so the end date has to be gone before the status
 * field flips, otherwise the second write is rejected the same way the first one
 * would have been.
 */
async function reactivate(subscriptionId) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ schedule_end: "" }),
  });
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "active" }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Reactivated by the pending-cancel repair script. Cleared the scheduled " +
            "end date and confirmed the saved payment method before setting status " +
            "back to active.",
    }),
  });
}

export async function run(subscriptionId) {
  const subscription = await getSubscription(subscriptionId);
  const lastOrder = subscription ? await getLastOrder(subscription) : null;
  const paymentMethod = await getPaymentMethod(intentIdOf(lastOrder));
  const [action, reason] = decide(subscription, lastOrder, paymentMethod);

  if (action === "skip") {
    console.log(`Subscription ${subscriptionId}: ${reason}`);
    return;
  }
  if (action === "blocked") {
    console.warn(`Subscription ${subscriptionId} stayed pending-cancel: ${reason}`);
    return;
  }

  console.log(`Subscription ${subscriptionId}: ${reason}. ${DRY_RUN ? "would reactivate" : "reactivating"}`);
  if (!DRY_RUN) await reactivate(subscriptionId);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const subId = process.env.SUBSCRIPTION_ID;
  if (!subId) {
    console.error("Set SUBSCRIPTION_ID to the subscription post id to check");
    process.exit(1);
  }
  run(subId).catch((e) => { console.error(e); process.exit(1); });
}
