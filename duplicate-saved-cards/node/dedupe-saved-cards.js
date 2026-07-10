/**
 * Find WooCommerce customers with the same card saved more than once on Stripe.
 *
 * A retried checkout, a re-added card during a plan upgrade, or a customer portal
 * session can all attach a fresh Stripe PaymentMethod for a card the customer
 * already has on file. Stripe never merges these for you, so the same card sits
 * on the customer two, three, sometimes five times. This walks each customer's
 * saved cards, groups them by card fingerprint, keeps the one WooCommerce
 * actually uses for renewals (or the newest one if none is in use), and detaches
 * the rest. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/duplicate-saved-cards/
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

/**
 * Every Stripe PaymentMethod id this WooCommerce customer's active
 * subscriptions rely on for renewals. These are never candidates for removal.
 */
export async function tokensInUse(customerId) {
  const subs = await woo(`/subscriptions?customer=${customerId}&status=active,on-hold&per_page=100`);
  const used = new Set();
  for (const sub of subs) {
    for (const meta of sub.meta_data || []) {
      if (meta.key === "_stripe_source_id" && meta.value) used.add(meta.value);
    }
  }
  return used;
}

/**
 * Group a customer's saved cards by Stripe's card fingerprint. Two
 * PaymentMethod objects that share a fingerprint are the same physical card,
 * regardless of how many times it was re-added.
 */
export function groupByFingerprint(paymentMethods) {
  const groups = new Map();
  for (const pm of paymentMethods) {
    const fingerprint = pm.card && pm.card.fingerprint;
    if (!fingerprint) continue;
    if (!groups.has(fingerprint)) groups.set(fingerprint, []);
    groups.get(fingerprint).push(pm);
  }
  return groups;
}

/**
 * Given every saved card that shares one fingerprint, decide what to do with
 * each PaymentMethod id. Returns a Map of payment_method_id -> action, where
 * action is "keep" or "detach". Pure: no I/O, no Stripe or Woo calls.
 *
 * Rule: a single card is left alone. Among duplicates, any card already wired
 * to an active subscription is always kept, never detached, even if it is not
 * the newest. If more than one duplicate is in use (a rare split subscription
 * setup), keep all of those and only detach the unused ones. If none are in
 * use, keep the most recently created card and detach the rest, since the
 * newest one is the one the customer most likely intended to keep.
 */
export function decide(group, usedTokenIds) {
  if (group.length < 2) {
    return new Map(group.map((pm) => [pm.id, "keep"]));
  }

  const inUse = group.filter((pm) => usedTokenIds.has(pm.id));
  let keepIds;
  if (inUse.length > 0) {
    keepIds = new Set(inUse.map((pm) => pm.id));
  } else {
    const newest = group.reduce((a, b) => ((b.created || 0) > (a.created || 0) ? b : a));
    keepIds = new Set([newest.id]);
  }

  return new Map(group.map((pm) => [pm.id, keepIds.has(pm.id) ? "keep" : "detach"]));
}

async function savedCards(customerId) {
  const cards = [];
  for await (const pm of stripe.paymentMethods.list({ customer: customerId, type: "card" })) {
    cards.push(pm);
  }
  return cards;
}

async function detach(paymentMethodId) {
  await stripe.paymentMethods.detach(paymentMethodId);
}

/**
 * Every WooCommerce customer that has a Stripe customer id saved, paging
 * through the REST API.
 */
async function* wooCustomersWithStripeId() {
  let page = 1;
  while (true) {
    const batch = await woo(`/customers?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const customer of batch) {
      const meta = (customer.meta_data || []).find(
        (m) => m.key === "_stripe_customer_id" && m.value
      );
      if (meta) yield [customer.id, meta.value];
    }
    page++;
  }
}

export async function run() {
  let detached = 0;
  for await (const [wooCustomerId, stripeCustomerId] of wooCustomersWithStripeId()) {
    const methods = await savedCards(stripeCustomerId);
    const groups = groupByFingerprint(methods);
    const used = await tokensInUse(wooCustomerId);
    for (const [fingerprint, group] of groups) {
      if (group.length < 2) continue;
      const actions = decide(group, used);
      for (const [pmId, action] of actions) {
        if (action !== "detach") continue;
        console.log(
          `Customer ${wooCustomerId}: duplicate card ${pmId} (fingerprint ${fingerprint.slice(0, 8)}...). ` +
          `${DRY_RUN ? "would detach" : "detaching"}`
        );
        if (!DRY_RUN) await detach(pmId);
        detached++;
      }
    }
  }
  console.log(`Done. ${detached} duplicate card(s) ${DRY_RUN ? "to detach" : "detached"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
