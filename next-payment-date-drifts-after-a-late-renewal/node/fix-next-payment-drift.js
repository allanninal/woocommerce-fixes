/**
 * Correct a WooCommerce Subscriptions next payment date that drifted after a late renewal.
 *
 * When a renewal runs late, from a failed payment retry, a delayed Action Scheduler
 * run, or a manual retry from wp-admin, some paths recompute the next payment date
 * from the moment the late renewal completed instead of from the subscription's
 * original billing schedule. Each late renewal after that nudges the date a little
 * further off. This walks active subscriptions, recomputes the correct next payment
 * date from the billing interval and period anchored to the start date, and corrects
 * the stored date whenever it disagrees by more than a small tolerance, adding a
 * subscription note either way. Safe to run again and again. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/next-payment-date-drifts-after-a-late-renewal/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRIFT_TOLERANCE_HOURS = Number(process.env.DRIFT_TOLERANCE_HOURS || 6);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function daysInMonth(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

export function addInterval(date, period, interval) {
  const d = new Date(date.getTime());
  if (period === "day") {
    d.setUTCDate(d.getUTCDate() + interval);
    return d;
  }
  if (period === "week") {
    d.setUTCDate(d.getUTCDate() + interval * 7);
    return d;
  }
  if (period === "month" || period === "year") {
    const monthsToAdd = interval * (period === "year" ? 12 : 1);
    const monthIndex = d.getUTCMonth() + monthsToAdd;
    const year = d.getUTCFullYear() + Math.floor(monthIndex / 12);
    const month = ((monthIndex % 12) + 12) % 12;
    const day = Math.min(d.getUTCDate(), daysInMonth(year, month));
    return new Date(Date.UTC(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  }
  throw new Error(`unknown billing period: ${period}`);
}

export function correctNextPayment(startDate, period, interval, now) {
  // Pure: step forward in whole billing intervals from startDate until the
  // result is strictly after now. No I/O, so this is fully unit testable.
  if (interval <= 0) throw new Error("interval must be positive");
  let nextDate = addInterval(startDate, period, interval);
  let guard = 0;
  while (nextDate.getTime() <= now.getTime()) {
    nextDate = addInterval(nextDate, period, interval);
    guard += 1;
    if (guard > 10000) throw new Error("schedule did not converge, check inputs");
  }
  return nextDate;
}

export function decide(subscription, now, toleranceHours = DRIFT_TOLERANCE_HOURS) {
  // Pure decision: given a subscription and the current time, decide whether its
  // stored next payment date has drifted from the true schedule. No I/O here, so
  // this is fully unit testable.
  if (subscription.status !== "active") return ["skip", "subscription not active"];
  const { start_date_gmt: start, billing_period: period, billing_interval: interval, next_payment_date_gmt: stored } = subscription;
  if (!stored) return ["skip", "no next payment date stored yet"];
  const correct = correctNextPayment(start, period, Number(interval), now);
  const driftHours = (stored.getTime() - correct.getTime()) / 3600000;
  if (Math.abs(driftHours) <= toleranceHours) return ["ok", "next payment date matches the schedule"];
  const direction = driftHours > 0 ? "ahead of" : "behind";
  return ["fix", `stored date is ${Math.abs(driftHours).toFixed(1)}h ${direction} schedule`];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
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

async function* activeSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

function parseGmt(value) {
  if (!value) return null;
  return new Date(value.endsWith("Z") ? value : `${value}Z`);
}

async function correctSchedule(subscriptionId, correctDate, reason) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ next_payment_date_gmt: correctDate.toISOString().slice(0, 19) }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Next payment date corrected: ${reason}. Recomputed from the billing ` +
            `schedule and reset to ${correctDate.toISOString()}.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  const now = new Date();
  for await (const subscription of activeSubscriptions()) {
    const parsed = {
      ...subscription,
      start_date_gmt: parseGmt(subscription.start_date_gmt),
      next_payment_date_gmt: parseGmt(subscription.next_payment_date_gmt),
    };
    const [action, reason] = decide(parsed, now);
    if (action !== "fix") continue;
    const correctDate = correctNextPayment(
      parsed.start_date_gmt, parsed.billing_period, Number(parsed.billing_interval), now
    );
    console.warn(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await correctSchedule(subscription.id, correctDate, reason);
    fixed++;
  }
  console.log(`Done. ${fixed} subscription(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
