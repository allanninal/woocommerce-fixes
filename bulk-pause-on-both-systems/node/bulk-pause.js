/**
 * Pause a batch of WooCommerce subscriptions and their Stripe billing together.
 *
 * Bulk changing a WooCommerce Subscription to on-hold only updates the store side:
 * the subscription status and its scheduled renewal actions. It does not touch
 * Stripe. When billing runs through a Stripe Subscription object (common with
 * WooPayments and Stripe integrations), Stripe keeps generating invoices on its
 * own schedule until something explicitly pauses it. This script walks a list of
 * subscription IDs, reads the matching Stripe subscription, and pauses both sides
 * together: WooCommerce to on-hold, Stripe with pause_collection (void). Skips
 * anything already paused, cancelled, or missing a Stripe subscription id. Safe
 * by default (dry run). Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/bulk-pause-on-both-systems/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const SUBSCRIPTION_IDS = (process.env.SUBSCRIPTION_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const WOO_ENDED_STATUSES = new Set(["on-hold", "cancelled", "expired", "pending-cancel"]);
const STRIPE_ENDED_STATUSES = new Set(["canceled", "incomplete_expired", "paused"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

export function stripeSubIdOf(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_subscription_id" && meta.value) return meta.value;
  }
  const tid = subscription.transaction_id;
  return tid && tid.startsWith("sub_") ? tid : null;
}

async function getStripeSubscription(stripeSubId) {
  if (!stripeSubId) return null;
  try {
    return await stripe.subscriptions.retrieve(stripeSubId);
  } catch {
    return null;
  }
}

/**
 * Pure decision: no I/O, only plain objects in and a plain array out.
 * Returns [action, reason] where action is one of "pause", "skip", "orphan".
 */
export function decide(subscription, stripeSub) {
  if (WOO_ENDED_STATUSES.has(subscription.status)) {
    return ["skip", "WooCommerce subscription is not active"];
  }
  if (!stripeSub) return ["orphan", "no Stripe subscription id on file"];
  if (STRIPE_ENDED_STATUSES.has(stripeSub.status) || stripeSub.pause_collection) {
    return ["skip", "Stripe subscription already paused or ended"];
  }
  return ["pause", "active in WooCommerce and billing in Stripe"];
}

async function pauseBoth(subscriptionId, stripeSubId) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "on-hold" }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Bulk paused. Stripe subscription ${stripeSubId} set to ` +
            `pause_collection (void) so it stops billing while on hold.`,
    }),
  });
  await stripe.subscriptions.update(stripeSubId, { pause_collection: { behavior: "void" } });
}

export async function run() {
  if (!SUBSCRIPTION_IDS.length) {
    console.warn("SUBSCRIPTION_IDS is empty. Set it to a comma separated list of subscription ids.");
  }
  let paused = 0;
  for (const subId of SUBSCRIPTION_IDS) {
    const subscription = await woo(`/subscriptions/${subId}`);
    if (!subscription) {
      console.warn(`Subscription ${subId} not found in WooCommerce`);
      continue;
    }
    const stripeSubId = stripeSubIdOf(subscription);
    const stripeSub = await getStripeSubscription(stripeSubId);
    const [action, reason] = decide(subscription, stripeSub);
    if (action === "orphan") { console.warn(`Subscription ${subId}: ${reason}`); continue; }
    if (action === "skip") continue;
    console.log(`Subscription ${subId}: ${reason}. ${DRY_RUN ? "would pause" : "pausing"}`);
    if (!DRY_RUN) await pauseBoth(subId, stripeSubId);
    paused++;
  }
  console.log(`Done. ${paused} subscription(s) ${DRY_RUN ? "to pause" : "paused"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
