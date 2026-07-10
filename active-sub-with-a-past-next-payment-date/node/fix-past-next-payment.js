/**
 * Move an active WooCommerce subscription's next payment date forward when it has
 * fallen into the past.
 *
 * A subscription's status and its billing schedule are stored separately. The
 * status can stay Active while the scheduled Action Scheduler event that should
 * trigger the renewal quietly fails to run (WP-Cron disabled, a backed up queue, a
 * bad migration). When that happens, next_payment never advances and eventually
 * sits behind today. This walks Active subscriptions, skips any with a renewal
 * already in progress at Stripe, and reschedules the rest forward using their own
 * billing period and interval. Dry run by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/active-sub-with-a-past-next-payment-date/
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

const PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const DAY_MS = 24 * 60 * 60 * 1000;
const IN_PROGRESS_STATUSES = new Set(["processing", "requires_action", "requires_capture"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* activeSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

/** The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id. */
export function intentIdOf(order) {
  for (const meta of (order || {}).meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = (order || {}).transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/** True when the subscription's last order has a Stripe PaymentIntent that is
 * still mid-flight, so we should not race it by touching the schedule. */
async function renewalInProgress(lastOrder) {
  const intentId = intentIdOf(lastOrder);
  if (!intentId) return false;
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    return IN_PROGRESS_STATUSES.has(intent.status);
  } catch {
    return false;
  }
}

/** Step nextPayment (epoch ms) forward by whole billing periods until it is in
 * the future. Pure: no I/O, easy to unit test. */
export function advance(nextPayment, period, interval, now) {
  const stepMs = PERIOD_DAYS[period] * interval * DAY_MS;
  if (stepMs <= 0) return nextPayment;
  let fixed = nextPayment;
  while (fixed <= now) fixed += stepMs;
  return fixed;
}

/** Pure decision function: given a subscription view, the current time (epoch
 * ms), and whether a renewal is already in progress, decide what to do.
 *
 * sub is expected to have: status, next_payment (epoch ms or null),
 * billing_period, billing_interval.
 *
 * Returns [action, reason, fixedDate] where action is "skip" or "reschedule".
 */
export function decide(sub, now, renewalInProgressFlag = false) {
  if (sub.status !== "active") return ["skip", "subscription not active", null];
  if (renewalInProgressFlag) return ["skip", "a renewal is already in progress", null];
  const nextPayment = sub.next_payment;
  if (nextPayment == null || nextPayment > now) {
    return ["skip", "next payment date is not in the past", null];
  }
  const period = sub.billing_period || "month";
  const interval = Number(sub.billing_interval || 1) || 1;
  if (!(period in PERIOD_DAYS) || interval < 1) {
    return ["skip", "unknown billing schedule", null];
  }
  const fixed = advance(nextPayment, period, interval, now);
  return ["reschedule", "next payment was in the past", fixed];
}

async function reschedule(subId, fixedDate) {
  const iso = new Date(fixedDate).toISOString().replace("T", " ").slice(0, 19);
  await woo(`/subscriptions/${subId}`, {
    method: "PUT",
    body: JSON.stringify({ next_payment_date_gmt: iso }),
  });
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Repaired by the schedule fixer. Next payment was in the past, ` +
            `moved forward to ${new Date(fixedDate).toISOString()}.`,
    }),
  });
}

function parseWcDate(value) {
  if (!value) return null;
  return new Date(value.endsWith("Z") ? value : value + "Z").getTime();
}

export async function run() {
  const now = Date.now() - GRACE_HOURS * 60 * 60 * 1000;
  let fixedCount = 0;
  for await (const sub of activeSubscriptions()) {
    const subView = {
      status: sub.status,
      next_payment: parseWcDate(sub.next_payment_date_gmt),
      billing_period: sub.billing_period,
      billing_interval: sub.billing_interval,
    };
    const inProgress = await renewalInProgress(sub.last_order);
    const [action, reason, fixedDate] = decide(subView, now, inProgress);
    if (action !== "reschedule") continue;
    console.log(
      `Subscription ${sub.id}: ${reason}. New date ${new Date(fixedDate).toISOString()}. ` +
      `${DRY_RUN ? "would fix" : "fixing"}`
    );
    if (!DRY_RUN) await reschedule(sub.id, fixedDate);
    fixedCount++;
  }
  console.log(`Done. ${fixedCount} subscription(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
