/**
 * Find WooCommerce Subscriptions with no customer attached, and flag or
 * repair the ones that are genuinely orphaned.
 *
 * A subscription is supposed to belong to a WordPress user, stored as
 * `customer_id` on the subscription. A deleted account, a GDPR erasure
 * request, a failed account step during signup, or a bad import can leave a
 * subscription with `customer_id` set to 0 while Stripe is still billing
 * the saved card behind it every cycle. Nobody notices, because the
 * renewal still succeeds. This walks recent subscriptions, decides what is
 * wrong with a pure function, and either reports it (dry run) or repairs
 * it: reattach the subscription to the WooCommerce user Stripe metadata
 * already names, or flag it for a human when no such user can be found.
 * Safe by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/orphaned-subscriptions-with-no-customer/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 90);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ACTIVE_LIKE_STATUSES = new Set(["active", "on-hold", "pending-cancel"]);

export function intentIdOf(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = subscription.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function decide(subscription, wooUserExists, stripeOwnerId) {
  const status = subscription.status;
  if (!ACTIVE_LIKE_STATUSES.has(status)) {
    return ["skip", "subscription is not in an active-like status"];
  }

  const customerId = subscription.customer_id || 0;
  if (customerId && wooUserExists) {
    return ["ok", "subscription has a real WooCommerce customer"];
  }

  if (stripeOwnerId) {
    return ["reattach", "Stripe metadata names a WooCommerce user that still exists"];
  }

  return ["orphan", "no WooCommerce customer, and Stripe has no owner to reattach to"];
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

async function* listSubscriptions(lookbackDays) {
  const after = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?after=${after}&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const subscription of batch) yield subscription;
    page++;
  }
}

async function wooUserExists(customerId) {
  if (!customerId) return false;
  const user = await woo(`/customers/${customerId}`);
  return Boolean(user);
}

async function stripeOwnerOf(subscription) {
  const intentId = intentIdOf(subscription);
  if (!intentId) return null;
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
  const ownerId = (intent.metadata || {}).woo_customer_id;
  return ownerId || null;
}

async function reattach(subscriptionId, customerId) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ customer_id: Number(customerId) }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Reattached to WooCommerce customer ${customerId} using the owner named in ` +
            `Stripe PaymentIntent metadata. Fixed by the orphan reconciler.`,
    }),
  });
}

async function flag(subscriptionId, reason) {
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Orphan check failed: ${reason}. This subscription has no WooCommerce customer ` +
            `attached and Stripe has no owner to reattach it to. Please review.`,
    }),
  });
}

export async function run() {
  let reattached = 0;
  let flagged = 0;

  for await (const subscription of listSubscriptions(LOOKBACK_DAYS)) {
    const customerId = subscription.customer_id || 0;
    const exists = await wooUserExists(customerId);
    const ownerId = customerId && exists ? null : await stripeOwnerOf(subscription);
    const [action, reason] = decide(subscription, exists, ownerId);

    if (action === "ok" || action === "skip") continue;

    const subId = subscription.id;
    if (action === "reattach") {
      console.log(`Subscription ${subId}: ${reason}. ${DRY_RUN ? "would reattach" : "reattaching"}`);
      if (!DRY_RUN) await reattach(subId, ownerId);
      reattached++;
      continue;
    }

    console.warn(`Subscription ${subId}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) await flag(subId, reason);
    flagged++;
  }

  console.log(`Done. ${reattached} reattached, ${flagged} flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
