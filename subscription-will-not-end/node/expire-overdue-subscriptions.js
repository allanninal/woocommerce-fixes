/**
 * Expire WooCommerce Subscriptions whose end date has already passed.
 *
 * A subscription with a schedule "end_date" is supposed to stop billing and move to
 * Expired on its own, driven by an Action Scheduler hook. If that hook was deleted,
 * never queued, or missed its run while the site was down, the subscription just sits
 * on Active (or On hold) forever with an end date in the past. This walks
 * subscriptions with a set end_date, checks whether that date has passed, and moves
 * any overdue one to Expired through the REST API, the same way the scheduled hook
 * would have. It also does a best-effort check with Stripe to cancel a stale
 * PaymentIntent left on a subscription that should already be gone. Read only by
 * default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/subscription-will-not-end/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const GRACE_HOURS = Number(process.env.GRACE_HOURS || 6);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const OPEN_STATUSES = new Set(["active", "on-hold", "pending-cancel"]);
const NO_END_DATE = "0000-00-00 00:00:00";

export function parseGmt(value) {
  if (!value || value === NO_END_DATE) return null;
  const text = value.replace("T", " ").replace("Z", "") + "Z";
  const iso = text.replace(" ", "T");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function intentIdOf(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = subscription.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision: should this subscription be expired right now?
 * `now` is a Date, passed in so the function has no hidden clock and stays pure.
 */
export function decide(subscription, now) {
  if (!OPEN_STATUSES.has(subscription.status)) {
    return ["skip", "subscription is not in an open state"];
  }
  const endDate = parseGmt(subscription.end_date_gmt);
  if (!endDate) {
    return ["skip", "subscription has no end date, it renews until cancelled"];
  }
  if (now < endDate) {
    return ["skip", "end date has not arrived yet"];
  }
  const overdueHours = (now - endDate) / 3600000;
  if (overdueHours < GRACE_HOURS) {
    return ["wait", "end date passed but still inside the grace window"];
  }
  return ["expire", `end date passed ${overdueHours.toFixed(1)}h ago and is still open`];
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

async function* openSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,on-hold,pending-cancel&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const subscription of batch) yield subscription;
    page++;
  }
}

async function cancelStaleMandate(subscription) {
  const intentId = intentIdOf(subscription);
  if (!intentId) return;
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (["requires_capture", "requires_confirmation", "requires_action"].includes(intent.status)) {
      await stripe.paymentIntents.cancel(intentId);
      console.log(`Cancelled stale PaymentIntent ${intentId} on subscription ${subscription.id}`);
    }
  } catch (err) {
    console.warn(`Could not check/cancel PaymentIntent ${intentId}: ${err.message}`);
  }
}

async function markExpired(subscriptionId, reason) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "expired" }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Expired by the scheduled check: ${reason}. ` +
            `The end date had passed but the subscription was still open.`,
    }),
  });
}

export async function run() {
  const now = new Date();
  let expired = 0;
  for await (const subscription of openSubscriptions()) {
    const [action, reason] = decide(subscription, now);
    if (action !== "expire") continue;
    console.log(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would expire" : "expiring"}`);
    if (!DRY_RUN) {
      await cancelStaleMandate(subscription);
      await markExpired(subscription.id, reason);
    }
    expired++;
  }
  console.log(`Done. ${expired} subscription(s) ${DRY_RUN ? "to expire" : "expired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
