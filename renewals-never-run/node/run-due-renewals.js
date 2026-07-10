/**
 * Trigger WooCommerce Subscriptions renewals that Action Scheduler stopped running.
 *
 * When the Action Scheduler queue stalls (a fatal error in one action, a maxed out
 * worker, a cron that stopped firing) the scheduled-subscription-payment actions
 * pile up "pending" long past their scheduled_date. WooCommerce never asked Stripe
 * for the money, so the subscription just sits there looking active while nothing
 * is billed.
 *
 * This walks subscriptions that look like stuck renewals, reads the saved Stripe
 * payment method, and charges the renewal amount directly through the Stripe API,
 * then reports the result back onto the order. Safe to run again and again.
 * Read only in DRY_RUN mode.
 *
 * Guide: https://www.allanninal.dev/woocommerce/renewals-never-run/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const GRACE_HOURS = Number(process.env.GRACE_HOURS || 3);
const STALE_DAYS = Number(process.env.STALE_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const RENEWABLE_STATUSES = new Set(["active", "on-hold"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since 50.00 is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

function hoursOverdue(scheduledTs, nowTs) {
  return (nowTs - scheduledTs) / 3600;
}

/**
 * Pure decision: what to do about one subscription's due renewal.
 *
 * subscription is a plain object with:
 *   status: the subscription status string
 *   nextPaymentTs: unix timestamp (seconds) the renewal was scheduled for, or null
 *   lastOrderStatus: status of the most recent renewal order, or null
 *   paymentMethodToken: a saved Stripe payment method id, or null
 *
 * Returns [action, reason] where action is one of:
 *   "skip"    - nothing due, or already handled
 *   "wait"    - due, but still inside the grace window, leave it to the scheduler
 *   "charge"  - due, past grace, and we have what we need to charge it
 *   "blocked" - due, past grace, but there is no saved payment method to charge
 *   "stale"   - overdue so long it needs a human, not an auto charge
 */
export function decide(subscription, nowTs, graceHours = GRACE_HOURS, staleDays = STALE_DAYS) {
  if (!RENEWABLE_STATUSES.has(subscription.status)) {
    return ["skip", "subscription is not active or on-hold"];
  }
  if (subscription.nextPaymentTs === null || subscription.nextPaymentTs === undefined) {
    return ["skip", "no renewal scheduled"];
  }
  if (["processing", "completed"].includes(subscription.lastOrderStatus)) {
    return ["skip", "renewal already paid"];
  }

  const overdueHours = hoursOverdue(subscription.nextPaymentTs, nowTs);
  if (overdueHours < 0) return ["skip", "renewal is not due yet"];
  if (overdueHours < graceHours) return ["wait", "inside the grace window, scheduler may still catch it"];
  if (overdueHours >= staleDays * 24) return ["stale", "overdue longer than the stale window, needs a human look"];
  if (!subscription.paymentMethodToken) return ["blocked", "no saved payment method to charge"];
  return ["charge", "past due and past grace, safe to charge now"];
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

async function* dueSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,on-hold&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function chargeRenewal(subscription, order) {
  const amount = orderAmountMinor(order);
  const intent = await stripe.paymentIntents.create({
    amount,
    currency: (order.currency || "usd").toLowerCase(),
    customer: subscription.customer_stripe_id,
    payment_method: subscription.payment_method_token,
    off_session: true,
    confirm: true,
    metadata: { order_id: String(order.id), subscription_id: String(subscription.id) },
  });
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ status: "processing", transaction_id: intent.id }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Renewal charged manually after Action Scheduler stalled. ` +
            `Stripe PaymentIntent ${intent.id}, status ${intent.status}.`,
    }),
  });
  return intent;
}

export async function run() {
  let charged = 0;
  const nowTs = Math.floor(Date.now() / 1000);
  for await (const sub of dueSubscriptions()) {
    const order = sub.last_order || {};
    const record = {
      status: sub.status,
      nextPaymentTs: sub.next_payment_ts ?? null,
      lastOrderStatus: order.status ?? null,
      paymentMethodToken: sub.payment_method_token ?? null,
    };
    const [action, reason] = decide(record, nowTs);
    if (action === "skip" || action === "wait") continue;
    if (action === "blocked" || action === "stale") {
      console.warn(`Subscription ${sub.id}: ${action}. ${reason}`);
      continue;
    }
    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would charge" : "charging"}`);
    if (!DRY_RUN) await chargeRenewal(sub, order);
    charged++;
  }
  console.log(`Done. ${charged} renewal(s) ${DRY_RUN ? "to charge" : "charged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
