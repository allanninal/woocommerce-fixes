/**
 * Find Stripe customers with no matching WooCommerce user behind them, and
 * WooCommerce users whose saved Stripe customer no longer exists.
 *
 * A WooCommerce user stores the Stripe customer id in user meta
 * `_stripe_customer_id`. A deleted WordPress user, a database import, or a
 * customer merge can leave that link pointing at nothing, or pointing at a
 * Stripe customer that actually belongs to someone else now. Meanwhile
 * Stripe can be holding a customer object, and a saved card, that no
 * WooCommerce user ever claims. This walks both sides, decides what is
 * wrong with a pure function, and either reports it (dry run) or repairs
 * it: reconnect a link that just moved, or delete a Stripe customer that is
 * genuinely abandoned and has no subscriptions or payment methods worth
 * keeping. Safe by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/orphaned-customers-and-cards/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 90);
const DELETE_ABANDONED = (process.env.DELETE_ABANDONED || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O, no Stripe or WooCommerce calls inside.
 *
 * customer: an object shaped like a Stripe Customer, or null if Stripe has
 *           no such customer (deleted or never existed).
 * wooUser:  an object shaped like a WooCommerce customer record, or null if
 *           no WooCommerce user claims this Stripe customer id.
 *
 * Returns [action, reason]. Actions:
 *   "ok"          nothing wrong, the link is good.
 *   "reconnect"   the Stripe customer exists and metadata.woo_customer_id
 *                 names a real, different WooCommerce user. Point the
 *                 record at that user instead of deleting anything.
 *   "orphan"      the Stripe customer exists but no WooCommerce user claims
 *                 it, and it has no subscriptions and no saved payment
 *                 methods. Safe to delete once DELETE_ABANDONED is on.
 *   "keep"        the Stripe customer exists, no WooCommerce user claims
 *                 it, but it still has a subscription or a saved card, so
 *                 it is left alone and only reported.
 *   "broken-link" a WooCommerce user has a saved Stripe customer id that
 *                 Stripe does not recognize any more. Needs a human to
 *                 reconnect it to the right customer or clear the field.
 */
export function decide(customer, wooUser) {
  if (!customer) {
    return ["broken-link", "WooCommerce points to a Stripe customer id Stripe does not have"];
  }

  if (customer.deleted) {
    return ["broken-link", "the Stripe customer behind this id was deleted"];
  }

  const linkedWooId = (customer.metadata || {}).woo_customer_id;

  if (wooUser) {
    if (linkedWooId && String(linkedWooId) !== String(wooUser.id)) {
      return ["reconnect", "Stripe metadata points to a different WooCommerce user"];
    }
    return ["ok", "Stripe customer and WooCommerce user agree"];
  }

  // No WooCommerce user claims this Stripe customer.
  if (linkedWooId) {
    return ["reconnect", "Stripe metadata names a WooCommerce user id that no longer exists"];
  }

  const hasSubscription = Boolean(customer.has_active_subscription);
  const hasPaymentMethod = Boolean(customer.has_payment_method);
  if (hasSubscription || hasPaymentMethod) {
    return ["keep", "no WooCommerce user, but a subscription or saved card is still attached"];
  }

  return ["orphan", "no WooCommerce user, no subscription, no saved payment method"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* listStripeCustomers(lookbackDays) {
  const since = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  for await (const customer of stripe.customers.list({ limit: 100, created: { gte: since } })) {
    yield customer;
  }
}

/**
 * Attach the two cheap-to-check facts decide() needs: an active
 * subscription, or at least one saved payment method. Both come straight
 * from the Stripe API, kept separate from decide() so decide() stays pure.
 */
async function enrich(customer) {
  const [subs, cards] = await Promise.all([
    stripe.subscriptions.list({ customer: customer.id, status: "active", limit: 1 }),
    stripe.paymentMethods.list({ customer: customer.id, type: "card", limit: 1 }),
  ]);
  return {
    ...customer,
    has_active_subscription: subs.data.length > 0,
    has_payment_method: cards.data.length > 0,
  };
}

/**
 * Look up the WooCommerce customer whose meta _stripe_customer_id matches.
 * The WooCommerce REST API does not filter customers by arbitrary meta, so
 * we search by the value and confirm the meta match ourselves rather than
 * trusting the search to be exact.
 */
async function findWooUserByStripeId(stripeCustomerId) {
  const users = await woo(`/customers?search=${encodeURIComponent(stripeCustomerId)}&per_page=10`);
  for (const user of users) {
    for (const meta of user.meta_data || []) {
      if (meta.key === "_stripe_customer_id" && meta.value === stripeCustomerId) return user;
    }
  }
  return null;
}

async function reconnect(wooUserId, stripeCustomerId) {
  await woo(`/customers/${wooUserId}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: "_stripe_customer_id", value: stripeCustomerId }] }),
  });
}

async function deleteStripeCustomer(stripeCustomerId) {
  await stripe.customers.del(stripeCustomerId);
}

export async function run() {
  let reconnected = 0;
  let deleted = 0;
  let flagged = 0;

  for await (const customer of listStripeCustomers(LOOKBACK_DAYS)) {
    const stripeCustomerId = customer.id;
    const wooUser = await findWooUserByStripeId(stripeCustomerId);
    const enriched = await enrich(customer);
    const [action, reason] = decide(enriched, wooUser);

    if (action === "ok") continue;

    if (action === "keep") {
      console.log(`Customer ${stripeCustomerId}: ${reason}. Leaving it alone.`);
      flagged++;
      continue;
    }

    if (action === "broken-link") {
      console.warn(`WooCommerce user pointing at ${stripeCustomerId} is broken: ${reason}`);
      flagged++;
      continue;
    }

    if (action === "reconnect") {
      const targetId = (enriched.metadata || {}).woo_customer_id;
      console.log(`Customer ${stripeCustomerId}: ${reason}. ${DRY_RUN ? "would reconnect" : "reconnecting"}`);
      if (!DRY_RUN && targetId) await reconnect(targetId, stripeCustomerId);
      reconnected++;
      continue;
    }

    if (action === "orphan") {
      const willDelete = !DRY_RUN && DELETE_ABANDONED;
      console.log(`Customer ${stripeCustomerId}: ${reason}. ${willDelete ? "deleting" : "would delete"}`);
      if (willDelete) {
        await deleteStripeCustomer(stripeCustomerId);
        deleted++;
      } else {
        flagged++;
      }
    }
  }

  console.log(`Done. ${reconnected} reconnected, ${deleted} deleted, ${flagged} flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
