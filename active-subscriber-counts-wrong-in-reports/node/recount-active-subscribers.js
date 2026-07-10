/**
 * Recount the active subscriber total from real subscriptions, not the cached report.
 *
 * WooCommerce Subscriptions reports read a stored total (a transient, a report table
 * row, or an option updated by a scheduled action) instead of counting live
 * subscriptions. When that cache misses a status change, an expired trial, or a
 * failed renewal that should have ended the subscription, the "Active subscribers"
 * number on the dashboard drifts from reality. This walks every subscription from
 * the WooCommerce REST API, decides with a pure function whether each one is a real
 * active subscriber right now, cross-checks a sample against Stripe when a
 * subscription id is on the order, and reports the corrected count. Read only by
 * default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/active-subscriber-counts-wrong-in-reports/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const STRIPE_SAMPLE_SIZE = Number(process.env.STRIPE_SAMPLE_SIZE || 20);

// Statuses that are still real subscribers even though billing is paused right now.
const COUNTS_AS_SUBSCRIBER = new Set(["active", "pending-cancel"]);

export function intentIdOf(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_subscription_id" && meta.value) return meta.value;
  }
  const tid = subscription.transaction_id;
  return tid && (tid.startsWith("sub_") || tid.startsWith("pi_")) ? tid : null;
}

/**
 * Pure decision: does this one subscription count toward "active subscribers"?
 *
 * This is the rule the cached report skips. A subscription counts only when
 * WooCommerce Subscriptions itself would treat it as active or pending-cancel
 * (still billing or still owed one more charge), and it is not a free trial that
 * has not converted, and it has not passed its end date.
 */
export function isRealSubscriber(subscription) {
  const status = subscription.status;
  if (!COUNTS_AS_SUBSCRIBER.has(status)) return false;
  if (subscription.trial_end && subscription.has_converted_from_trial === false) return false;
  const end = subscription.end_date;
  const now = subscription._now;
  if (end && now && end <= now) return false;
  return true;
}

/** Pure function: count real active subscribers out of a list of subscriptions. */
export function recount(subscriptions) {
  return subscriptions.filter(isRealSubscriber).length;
}

/**
 * Pure function: decide whether the cached report total needs a repair.
 *
 * A small rounding style gap of zero is fine. Anything else is a drift worth
 * reporting, and a large gap is worth flagging loudly.
 */
export function decide(cachedCount, realCount) {
  const diff = realCount - cachedCount;
  if (diff === 0) return ["ok", "cached total matches the real count", diff];
  if (Math.abs(diff) <= 2) return ["drift", "small drift, safe to auto repair", diff];
  return ["drift-large", "large drift, review before trusting the auto repair", diff];
}

/**
 * Pure function: does the live Stripe object agree this is a real subscriber?
 *
 * Used only to spot check a sample, since the WooCommerce status is the source of
 * truth for what a "subscriber" means to this store, but a live Stripe status that
 * disagrees is worth a warning.
 */
export function stripeStatusAgrees(subscription, stripeSubscription) {
  if (!stripeSubscription) return null;
  const wooSaysActive = isRealSubscriber(subscription);
  const stripeSaysActive = ["active", "trialing", "past_due"].includes(stripeSubscription.status);
  return wooSaysActive === stripeSaysActive;
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getStripeSubscription(subOrIntentId) {
  if (!subOrIntentId) return null;
  try {
    if (subOrIntentId.startsWith("sub_")) {
      return await stripe.subscriptions.retrieve(subOrIntentId);
    }
    const intent = await stripe.paymentIntents.retrieve(subOrIntentId);
    if (!intent.invoice) return null;
    const invoice = await stripe.invoices.retrieve(intent.invoice);
    return invoice.subscription ? await stripe.subscriptions.retrieve(invoice.subscription) : null;
  } catch {
    return null;
  }
}

async function* allSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function getCachedReportTotal() {
  const rows = await woo("/reports/subscriptions/totals");
  const row = rows.find((r) => r.slug === "active");
  return row ? Number(row.total) : 0;
}

async function writeCorrectedTotal(realCount) {
  await woo("/settings/subscriptions/woocommerce_subscriptions_active_count_cache", {
    method: "POST",
    body: JSON.stringify({ value: String(realCount) }),
  });
}

export async function run() {
  const subscriptions = [];
  for await (const sub of allSubscriptions()) subscriptions.push(sub);

  const realCount = recount(subscriptions);
  const cachedCount = await getCachedReportTotal();
  const [action, reason, diff] = decide(cachedCount, realCount);

  if (action === "ok") {
    console.log(`Report is correct. Active subscribers: ${realCount}.`);
    return;
  }

  console.warn(
    `Active subscriber report is wrong. cached=${cachedCount} real=${realCount} diff=${diff >= 0 ? "+" : ""}${diff} (${reason})`
  );

  const sample = subscriptions.slice(0, STRIPE_SAMPLE_SIZE);
  let disagreements = 0;
  for (const sub of sample) {
    const stripeSub = await getStripeSubscription(intentIdOf(sub));
    const agrees = stripeStatusAgrees(sub, stripeSub);
    if (agrees === false) {
      disagreements++;
      console.warn(`Subscription ${sub.id}: Stripe status disagrees with WooCommerce status.`);
    }
  }
  if (disagreements) {
    console.warn(`${disagreements} of ${sample.length} sampled subscriptions disagree with Stripe. Investigate before trusting the repair.`);
  }

  if (action === "drift-large" && !DRY_RUN) {
    console.warn("Large drift found. Not auto repairing. Re-run with the report reviewed first.");
    return;
  }

  console.log(`${DRY_RUN ? "Would" : "Applying"} repair the cached total from ${cachedCount} to ${realCount}.`);
  if (!DRY_RUN) await writeCorrectedTotal(realCount);
  console.log(`Done. Real active subscriber count is ${realCount}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
