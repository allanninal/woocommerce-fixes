/**
 * Detect and clear a trial end action that Action Scheduler logged as
 * failed by mistake, even though the subscription already moved out of
 * the trial.
 *
 * WooCommerce Subscriptions runs woocommerce_scheduled_subscription_trial_end
 * on the trial end date. When a slow request, a second worker, or a timeout
 * makes that hook run twice, the loser of the race throws and Action
 * Scheduler marks the action failed, but the subscription already has the
 * correct status and the first renewal order already exists. The failed log
 * entry is then a false alarm, not a real billing problem.
 *
 * This script pulls subscriptions that still show a trial-end action as
 * failed, checks the subscription status and its renewal order (and, when a
 * renewal order exists, its Stripe PaymentIntent) against the real state,
 * and adds a note that clears the alarm when everything actually succeeded.
 * It never re-runs the trial-end transition itself, since that is what
 * caused the duplicate-run risk in the first place. Read only unless
 * DRY_RUN is off.
 *
 * Guide: https://www.allanninal.dev/woocommerce/trial-end-action-false-positive-failure/
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

// Statuses that mean the subscription is no longer sitting in a trial.
const POST_TRIAL_STATUSES = new Set(["active", "on-hold", "pending-cancel", "cancelled"]);

export function intentIdOf(order) {
  for (const meta of (order || {}).meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = (order || {}).transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision function. No I/O. Returns [action, reason].
 *
 * action is one of:
 *   "leave"    - the trial-end action failure looks real, do nothing
 *   "clear"    - the failure was a false positive, clear the alarm
 *   "unclear"  - not enough evidence either way, needs a human to look
 */
export function decide(subscription, renewalOrder, intent) {
  if (!POST_TRIAL_STATUSES.has(subscription.status)) {
    return ["leave", "subscription is still on trial or has no post-trial status"];
  }

  if (subscription.status === "active" && !renewalOrder) {
    if ((subscription.trial_total_minor || 0) === 0) {
      return ["clear", "subscription is active and the trial had no charge due"];
    }
    return ["unclear", "active with no renewal order and a nonzero trial amount"];
  }

  if (!renewalOrder) {
    return ["unclear", "no renewal order found to check against Stripe"];
  }

  if (renewalOrder.status === "cancelled" || renewalOrder.status === "failed") {
    return ["leave", "the renewal order itself failed or was cancelled"];
  }

  if (!intent) {
    return ["unclear", "renewal order has no matching Stripe PaymentIntent yet"];
  }

  if (intent.status !== "succeeded") {
    return ["leave", "Stripe shows the renewal payment did not succeed"];
  }

  if (Math.abs(orderAmountMinor(renewalOrder) - (intent.amount_received || 0)) > 1) {
    return ["unclear", "renewal order amount does not match the Stripe charge"];
  }

  return ["clear", "subscription moved past trial and the renewal charge succeeded on Stripe"];
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

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

function latestRenewalOrderId(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_last_renewal_order_id" && meta.value) return meta.value;
  }
  const related = (subscription._links || {}).renewal_order || [];
  if (!related.length) return null;
  const href = related[0].href.replace(/\/$/, "");
  return href.split("/").pop();
}

async function* flaggedSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(
      `/subscriptions?status=any&per_page=50&page=${page}` +
      `&meta_key=_trial_end_action_status&meta_value=failed`
    );
    if (!batch || !batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function clearAlarm(subscription, reason) {
  await woo(`/subscriptions/${subscription.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Trial end action false alarm cleared: ${reason}. ` +
            `The subscription and its renewal charge are confirmed correct, ` +
            `so the failed Action Scheduler entry can be ignored.`,
    }),
  });
}

export async function run() {
  let cleared = 0;
  for await (const subscription of flaggedSubscriptions()) {
    const orderId = latestRenewalOrderId(subscription);
    const renewalOrder = orderId ? await woo(`/orders/${orderId}`) : null;
    const intent = await getIntent(intentIdOf(renewalOrder));
    const [action, reason] = decide(subscription, renewalOrder, intent);
    if (action !== "clear") {
      if (action === "unclear") {
        console.warn(`Subscription ${subscription.id}: ${reason}. Needs a human look.`);
      }
      continue;
    }
    console.log(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would clear" : "clearing"}`);
    if (!DRY_RUN) await clearAlarm(subscription, reason);
    cleared++;
  }
  console.log(`Done. ${cleared} subscription(s) ${DRY_RUN ? "to clear" : "cleared"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
