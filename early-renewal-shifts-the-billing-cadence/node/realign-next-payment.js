/**
 * Realign a WooCommerce Subscription's next payment date after an early renewal.
 *
 * When a customer or store manager pays a renewal early ("Renew now" / pay it
 * forward), WooCommerce Subscriptions is supposed to push next_payment out to
 * one full billing period from that new paid date. A common bug in custom
 * "renew now" buttons and some REST driven manual renewals pays the order but
 * never calls the date update, so next_payment is left pointing at the old
 * cadence. The next charge then fires just days later instead of a full
 * period out, and every early renewal after that compounds the drift.
 *
 * This reads recent renewal orders and their parent subscriptions from the
 * WooCommerce REST API, works out what next_payment should be from the last
 * paid renewal date plus the billing interval, and corrects the
 * subscription's schedule when it has drifted. It also cross checks the paid
 * amount against the Stripe PaymentIntent (read from order meta
 * _stripe_intent_id, or transaction_id) so we only trust a renewal that
 * Stripe actually confirms.
 *
 * Safe by default. Read only unless DRY_RUN is set to false. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/early-renewal-shifts-the-billing-cadence/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 3);
const TOLERANCE_SECONDS = Number(process.env.TOLERANCE_SECONDS || 3600);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// One billing period in seconds, for the periods WooCommerce Subscriptions supports.
const PERIOD_SECONDS = {
  day: 86400,
  week: 7 * 86400,
  month: 30 * 86400,
  year: 365 * 86400,
};

export function parseWcDate(value) {
  if (!value) return null;
  // WooCommerce GMT date strings look like 2026-06-10T00:00:00, always UTC.
  return new Date(`${value}Z`);
}

export function formatWcDate(date) {
  return date.toISOString().slice(0, 19);
}

export function metaValue(item, key) {
  for (const meta of item.meta_data || []) {
    if (meta.key === key) return meta.value;
  }
  return null;
}

export function intentIdOf(order) {
  const stored = metaValue(order, "_stripe_intent_id");
  if (stored) return stored;
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/** Pure. What next_payment should be: one full billing period after the
 * renewal that was actually paid, regardless of when the old cadence
 * said the charge was "due". */
export function expectedNextPayment(paidAt, billingInterval, billingPeriod) {
  const seconds = PERIOD_SECONDS[billingPeriod] * billingInterval;
  return new Date(paidAt.getTime() + seconds * 1000);
}

/** Pure decision function. No I/O. Returns [action, reason].
 *
 * Actions:
 *   skip  - nothing to do, schedule already correct or renewal not confirmed
 *   hold  - cannot safely decide, missing data
 *   fix   - next_payment has drifted from where the early renewal should
 *           place it, and it needs to move to the corrected date
 */
export function decide(subscription, renewalOrder, intent) {
  if (!intent) return ["hold", "no Stripe PaymentIntent found for the renewal order"];
  if (intent.status !== "succeeded") return ["skip", "renewal payment not succeeded on Stripe"];
  if (Math.abs(orderAmountMinor(renewalOrder) - (intent.amount_received || 0)) > 1) {
    return ["hold", "renewal amount does not match the Stripe charge"];
  }

  const paidAt = parseWcDate(renewalOrder.date_paid_gmt || renewalOrder.date_created_gmt);
  const currentNextPayment = parseWcDate(metaValue(subscription, "_schedule_next_payment"));
  const billingInterval = Number(subscription.billing_interval || 1);
  const billingPeriod = subscription.billing_period;

  if (!paidAt || !PERIOD_SECONDS[billingPeriod]) {
    return ["hold", "missing paid date or unknown billing period"];
  }
  if (!currentNextPayment) {
    return ["hold", "subscription has no next payment date scheduled"];
  }

  const correctNextPayment = expectedNextPayment(paidAt, billingInterval, billingPeriod);
  const drift = Math.abs((currentNextPayment.getTime() - correctNextPayment.getTime()) / 1000);

  if (drift <= TOLERANCE_SECONDS) return ["skip", "next payment date already matches the paid renewal"];

  return ["fix", `next payment is off by ${Math.round(drift)}s from the corrected cadence`];
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

async function* recentRenewalOrders() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 19);
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${since}&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const order of batch) {
      if (metaValue(order, "_subscription_renewal")) yield order;
    }
    page++;
  }
}

async function getSubscription(subscriptionId) {
  return woo(`/subscriptions/${subscriptionId}`);
}

async function applyFix(subscriptionId, correctNextPayment) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [{ key: "_schedule_next_payment", value: formatWcDate(correctNextPayment) }],
    }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Realigned the next payment date after an early renewal. " +
            `New next payment: ${formatWcDate(correctNextPayment)} UTC.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const renewalOrder of recentRenewalOrders()) {
    const subscriptionId = metaValue(renewalOrder, "_subscription_renewal");
    const subscription = await getSubscription(subscriptionId);
    if (!subscription) {
      console.warn(`Renewal order ${renewalOrder.id} points to missing subscription ${subscriptionId}`);
      continue;
    }

    const intent = await getIntent(intentIdOf(renewalOrder));
    const [action, reason] = decide(subscription, renewalOrder, intent);

    if (action === "hold") { console.warn(`Subscription ${subscriptionId}: ${reason}`); continue; }
    if (action === "skip") continue;

    const paidAt = parseWcDate(renewalOrder.date_paid_gmt || renewalOrder.date_created_gmt);
    const billingInterval = Number(subscription.billing_interval || 1);
    const billingPeriod = subscription.billing_period;
    const correctNextPayment = expectedNextPayment(paidAt, billingInterval, billingPeriod);

    console.log(`Subscription ${subscriptionId}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await applyFix(subscriptionId, correctNextPayment);
    fixed++;
  }
  console.log(`Done. ${fixed} subscription(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
