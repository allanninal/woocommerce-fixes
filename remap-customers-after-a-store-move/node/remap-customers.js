/**
 * Remap WooCommerce orders to the correct customer after a store move.
 *
 * A migration usually re-creates WordPress users with new IDs while orders
 * keep their old numeric customer_id. This walks every order, finds the
 * WordPress user whose email matches the order's billing email, cross
 * checks that user's saved Stripe customer id against the order's Stripe
 * customer id, and only remaps when both signals agree on exactly one
 * account. Safe to run again and again; already-correct orders are skipped.
 * Read only until DRY_RUN is turned off.
 *
 * Guide: https://www.allanninal.dev/woocommerce/remap-customers-after-a-store-move/
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
  return res;
}

async function* allOrders() {
  let page = 1;
  while (true) {
    const res = await woo(`/orders?per_page=50&page=${page}&orderby=id&order=asc`);
    if (!res.ok) throw new Error(`Woo /orders returned ${res.status}`);
    const batch = await res.json();
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function userExists(customerId) {
  if (!customerId) return false;
  const res = await woo(`/customers/${customerId}`);
  return res.status === 200;
}

async function usersByEmail(email) {
  if (!email) return [];
  const res = await woo(`/customers?email=${encodeURIComponent(email)}&per_page=10`);
  if (!res.ok) throw new Error(`Woo /customers returned ${res.status}`);
  return res.json();
}

function metaValue(order, key) {
  for (const meta of order.meta_data || []) {
    if (meta.key === key && meta.value) return meta.value;
  }
  return null;
}

async function stripeCustomerIdOfOrder(order) {
  const direct = metaValue(order, "_stripe_customer_id");
  if (direct) return direct;
  const intentId = metaValue(order, "_stripe_intent_id") || order.transaction_id;
  if (intentId && intentId.startsWith("pi_")) {
    try {
      const intent = await stripe.paymentIntents.retrieve(intentId);
      return intent.customer || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** True unless both ids are present and disagree. */
export function stripeIdsAgree(orderStripeCustomerId, userStripeCustomerId) {
  if (!orderStripeCustomerId || !userStripeCustomerId) return true; // nothing to contradict
  return orderStripeCustomerId === userStripeCustomerId;
}

/**
 * Pure decision function: no I/O, easy to unit test.
 *
 * order: object with at least { id, customer_id }.
 * currentCustomerValid: boolean, whether order.customer_id resolves to a
 *   real WooCommerce customer on this site.
 * matchingUsers: array of WooCommerce customer objects whose email equals
 *   the order's billing email, each with at least an `id` field.
 */
export function decide(order, currentCustomerValid, matchingUsers) {
  if (currentCustomerValid) return ["skip", "customer_id already resolves to a real account"];
  if (matchingUsers.length === 0) return ["orphan", "no WordPress account matches this billing email"];
  if (matchingUsers.length > 1) return ["ambiguous", "more than one account shares this billing email"];
  const match = matchingUsers[0];
  if (match.id === order.customer_id) return ["skip", "already pointing at the matching account"];
  return ["remap", `remap to user ${match.id}`];
}

async function remapOrder(order, newCustomerId) {
  const oldId = order.customer_id;
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ customer_id: newCustomerId }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Remapped customer_id from ${oldId} to ${newCustomerId} after the store move. ` +
            `Matched by Stripe customer id and billing email.`,
    }),
  });
}

export async function run() {
  let remapped = 0;
  let reported = 0;
  for await (const order of allOrders()) {
    const currentValid = await userExists(order.customer_id);
    const email = (order.billing || {}).email;
    const candidates = currentValid ? [] : await usersByEmail(email);
    const [action, reason] = decide(order, currentValid, candidates);

    if (action === "skip") continue;

    if (action === "orphan" || action === "ambiguous") {
      console.warn(`Order ${order.id}: ${reason}`);
      reported++;
      continue;
    }

    const match = candidates[0];
    const orderStripeId = await stripeCustomerIdOfOrder(order);
    const userStripeId = match.meta_data_stripe_customer_id || null;
    if (!stripeIdsAgree(orderStripeId, userStripeId)) {
      console.warn(`Order ${order.id}: Stripe customer id disagrees with email match, skipping`);
      reported++;
      continue;
    }

    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would remap" : "remapping"}`);
    if (!DRY_RUN) await remapOrder(order, match.id);
    remapped++;
  }
  console.log(`Done. ${remapped} order(s) ${DRY_RUN ? "to remap" : "remapped"}, ${reported} reported for manual review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
