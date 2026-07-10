/**
 * Move WooCommerce Subscriptions out of pending-cancel when they are stuck there.
 *
 * pending-cancel is meant to be a short holding status: the customer cancelled, but
 * WooCommerce Subscriptions lets the current paid period finish before the
 * subscription becomes cancelled. That flip is supposed to happen through an Action
 * Scheduler hook named woocommerce_scheduled_subscription_end_of_prepaid_term,
 * scheduled for the subscription's end date. When that scheduled action never runs
 * (Action Scheduler stalled, WP-Cron disabled, a migration that lost the scheduled
 * action), the subscription sits in pending-cancel forever.
 *
 * This walks subscriptions with status pending-cancel, and for any whose end date
 * has passed, confirms with Stripe that the subscription is not still actively
 * billing, then moves it to cancelled through the WooCommerce REST API. Safe to run
 * again and again. Dry run by default.
 *
 * Guide: https://www.allanninal.dev/woocommerce/stuck-in-pending-cancel/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const GRACE_HOURS = Number(process.env.GRACE_HOURS || 2);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Stripe subscription statuses that mean Stripe still considers the subscription live.
const STRIPE_LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function stripeSubIdOf(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_subscription_id" && meta.value) return meta.value;
  }
  return null;
}

export function parseGmt(value) {
  if (!value || value.startsWith("0000-00-00")) return null;
  return new Date(`${value.replace(" ", "T")}Z`);
}

/**
 * Pure decision function. No I/O.
 *
 * subscription: a WooCommerce Subscriptions REST API subscription resource.
 * stripeSubscription: the matching Stripe Subscription object, or null when the
 *   subscription has no Stripe id, or Stripe has no record of it.
 * now: a Date, passed in so this is deterministic to test.
 *
 * Returns [action, reason] where action is one of "skip", "wait", "hold", "cancel".
 */
export function decide(subscription, stripeSubscription, now) {
  if (subscription.status !== "pending-cancel") {
    return ["skip", "subscription is not pending-cancel"];
  }

  const end = parseGmt(subscription.end_date_gmt || subscription.end_gmt);
  if (end === null) {
    return ["hold", "no end date set, cannot confirm the prepaid term is over"];
  }

  if (now.getTime() < end.getTime()) {
    return ["wait", "end date has not arrived yet"];
  }

  if (stripeSubIdOf(subscription) && stripeSubscription) {
    const stripeStatus = stripeSubscription.status;
    if (STRIPE_LIVE_STATUSES.has(stripeStatus)) {
      return ["hold", `Stripe still shows the subscription as ${stripeStatus}`];
    }
  }

  return ["cancel", "end date has passed and Stripe does not show it still billing"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getStripeSubscription(stripeSubId) {
  if (!stripeSubId) return null;
  try {
    return await stripe.subscriptions.retrieve(stripeSubId);
  } catch {
    return null;
  }
}

async function* pendingCancelSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=pending-cancel&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const subscription of batch) yield subscription;
    page++;
  }
}

async function cancel(subscriptionId, reason) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "cancelled" }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Moved from pending-cancel to cancelled by the reconciler. ${reason}.`,
    }),
  });
}

export async function run() {
  const now = new Date();
  let cancelled = 0;
  for await (const subscription of pendingCancelSubscriptions()) {
    const stripeSubId = stripeSubIdOf(subscription);
    const stripeSubscription = await getStripeSubscription(stripeSubId);
    const [action, reason] = decide(subscription, stripeSubscription, now);
    if (action === "skip" || action === "wait") continue;
    if (action === "hold") {
      console.warn(`Subscription ${subscription.id} left in pending-cancel: ${reason}`);
      continue;
    }
    console.log(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would cancel" : "cancelling"}`);
    if (!DRY_RUN) await cancel(subscription.id, reason);
    cancelled++;
  }
  console.log(`Done. ${cancelled} subscription(s) ${DRY_RUN ? "to cancel" : "cancelled"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
