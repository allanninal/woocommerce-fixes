/**
 * Cancel a batch of WooCommerce subscriptions on both WooCommerce and Stripe.
 *
 * Give it a list of WooCommerce subscription IDs. It reads the linked Stripe
 * subscription id from meta, checks the live status on both systems, and only
 * cancels the side that is not already cancelled. Subscriptions with no Stripe
 * id on file are reported as orphans instead of being skipped silently.
 * Safe to run again and again. Run with DRY_RUN=true first.
 *
 * Guide: https://www.allanninal.dev/woocommerce/bulk-cancel-and-keep-in-sync/
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

const WOO_CANCELLED_STATUSES = new Set(["cancelled"]);
const STRIPE_CANCELLED_STATUSES = new Set(["canceled", "incomplete_expired"]);

/** The saved Stripe subscription id, from meta _stripe_subscription_id or transaction_id. */
export function stripeSubIdOf(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_subscription_id" && meta.value) return meta.value;
  }
  const tid = subscription.transaction_id;
  return tid && tid.startsWith("sub_") ? tid : null;
}

/**
 * Pure decision function: no I/O, only reads plain objects.
 * Returns [action, reason]. action is one of:
 * "orphan", "skip", "cancel_both", "cancel_stripe_only", "cancel_woo_only".
 */
export function decide(wooSubscription, stripeSubscription) {
  if (!wooSubscription) return ["orphan", "woocommerce subscription not found"];

  const wooDone = WOO_CANCELLED_STATUSES.has(wooSubscription.status);

  if (!stripeSubscription) {
    return wooDone
      ? ["orphan", "no Stripe subscription id on file, cannot confirm Stripe side"]
      : ["orphan", "no Stripe subscription id on file, cancel Stripe by hand"];
  }

  const stripeDone = STRIPE_CANCELLED_STATUSES.has(stripeSubscription.status);

  if (wooDone && stripeDone) return ["skip", "already cancelled on both sides"];
  if (!wooDone && !stripeDone) return ["cancel_both", "active on both sides"];
  if (!stripeDone) return ["cancel_stripe_only", "woo cancelled, stripe still active"];
  return ["cancel_woo_only", "stripe cancelled, woo still active"];
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

async function getStripeSubscription(stripeSubId) {
  if (!stripeSubId) return null;
  try {
    return await stripe.subscriptions.retrieve(stripeSubId);
  } catch {
    return null;
  }
}

async function cancelOnStripe(stripeSubId) {
  await stripe.subscriptions.cancel(stripeSubId);
}

async function cancelOnWoo(subscriptionId) {
  await woo(`/orders/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "cancelled" }),
  });
}

async function addNote(subscriptionId, text) {
  await woo(`/orders/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({ note: text }),
  });
}

async function applyAction(action, subscriptionId, stripeSubId) {
  if (action === "cancel_both") {
    await cancelOnStripe(stripeSubId);
    await cancelOnWoo(subscriptionId);
    await addNote(subscriptionId, "Bulk cancel sync: cancelled on Stripe and WooCommerce.");
  } else if (action === "cancel_stripe_only") {
    await cancelOnStripe(stripeSubId);
    await addNote(subscriptionId, "Bulk cancel sync: WooCommerce was already cancelled, " +
      "Stripe subscription cancelled to match.");
  } else if (action === "cancel_woo_only") {
    await cancelOnWoo(subscriptionId);
    await addNote(subscriptionId, "Bulk cancel sync: Stripe was already cancelled, " +
      "WooCommerce status corrected to match.");
  }
}

export async function run() {
  let fixed = 0;
  let orphans = 0;
  for (const subscriptionId of SUBSCRIPTION_IDS) {
    const wooSubscription = await woo(`/orders/${subscriptionId}`);
    const stripeSubId = wooSubscription ? stripeSubIdOf(wooSubscription) : null;
    const stripeSubscription = await getStripeSubscription(stripeSubId);
    const [action, reason] = decide(wooSubscription, stripeSubscription);

    if (action === "orphan") {
      console.warn(`Subscription ${subscriptionId}: orphan. ${reason}`);
      orphans++;
      continue;
    }
    if (action === "skip") continue;

    console.log(`Subscription ${subscriptionId}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await applyAction(action, subscriptionId, stripeSubId);
    fixed++;
  }
  console.log(`Done. ${fixed} subscription(s) ${DRY_RUN ? "to fix" : "fixed"}, ${orphans} orphan(s) need manual review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
