/**
 * Restore automatic billing for free trial subscriptions that were forced to
 * manual renewal because the card save was never confirmed.
 *
 * A free trial checkout confirms a zero amount Stripe setup that is only
 * supposed to save a reusable card for later, no money moves yet. If that
 * confirmation is interrupted (closed tab, abandoned 3D Secure, a missing
 * script on the thank you page), the trial still completes but no payment
 * method is ever saved. When the trial ends, WooCommerce Subscriptions
 * correctly has nothing to charge and marks the subscription "requires
 * manual renewal" instead of failing silently.
 *
 * This job walks subscriptions currently on manual renewal, checks whether
 * Stripe now has a real, reusable, non-expired payment method for that
 * customer, and switches eligible subscriptions back to automatic. Safe by
 * default (dry run). Run on a schedule, once a day is plenty.
 *
 * Guide: https://www.allanninal.dev/woocommerce/free-trials-forced-to-manual-renewal/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* manualRenewalSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,pending&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) {
      if (sub.requires_manual_renewal) yield sub;
    }
    page++;
  }
}

export function stripeCustomerId(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_customer_id" && meta.value) return meta.value;
  }
  return null;
}

export async function usablePaymentMethod(customerId) {
  if (!customerId) return null;
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;
  for (const pm of methods.data) {
    const card = pm.card;
    if (card && !(card.exp_year < thisYear || (card.exp_year === thisYear && card.exp_month < thisMonth))) {
      return pm;
    }
  }
  return null;
}

/**
 * Pure decision: does this subscription get switched back to automatic?
 *
 * subscription: object with at least requires_manual_renewal.
 * paymentMethod: a Stripe PaymentMethod-like object (needs .id), or null.
 * Returns an [action, reason] tuple. action is one of "restore" or "skip".
 * No I/O happens here, so this can be unit tested without a network.
 */
export function decide(subscription, paymentMethod) {
  if (!subscription.requires_manual_renewal) return ["skip", "subscription is already automatic"];
  if (!paymentMethod) return ["skip", "no reusable payment method on file yet"];
  return ["restore", "Stripe has a usable card, safe to restore automatic billing"];
}

async function restoreAutomatic(subscriptionId, paymentMethod) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({
      requires_manual_renewal: false,
      meta_data: [{ key: "_stripe_source_id", value: paymentMethod.id }],
    }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Restored automatic renewal. Found reusable payment method ` +
            `${paymentMethod.id} on the Stripe customer. Set by the repair job.`,
    }),
  });
}

export async function run() {
  let restored = 0;
  for await (const sub of manualRenewalSubscriptions()) {
    const customerId = stripeCustomerId(sub);
    const pm = await usablePaymentMethod(customerId);
    const [action, reason] = decide(sub, pm);
    if (action === "skip") {
      console.log(`Subscription ${sub.id}: ${reason}`);
      continue;
    }
    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would restore" : "restoring"}`);
    if (!DRY_RUN) await restoreAutomatic(sub.id, pm);
    restored++;
  }
  console.log(`Done. ${restored} subscription(s) ${DRY_RUN ? "to restore" : "restored"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
