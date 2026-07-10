/**
 * Recreate WooCommerce Subscriptions renewals after a Stripe account move.
 *
 * When a store moves to a new Stripe account (a merge, a platform migration, or
 * a new Connect account), every saved card token that lived on the old account
 * stops working. WooCommerce Subscriptions still points renewal orders at the
 * old Stripe customer and payment method id, so the next scheduled renewal
 * fails with a Stripe error like "No such customer" or "No such payment_method".
 * This script finds subscriptions still tied to the old Stripe account, and for
 * any customer who already has a valid, chargeable payment method on the new
 * account, it re-points the subscription at the new Stripe customer and payment
 * method so the next renewal can actually be charged. Read-only planning by
 * default. Run once per migration, or on a schedule until the backlog clears.
 *
 * Guide: https://www.allanninal.dev/woocommerce/recreate-subs-after-account-move/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ACTIVE_SUB_STATUSES = new Set(["active", "on-hold"]);

/**
 * Pure decision: what should we do with this subscription's Stripe link.
 *
 * subscription: { status, _stripe_customer_id, _stripe_source_id } the ids
 *   saved on the subscription today.
 * newToken: object or null. When present, it is the customer's newest valid,
 *   chargeable payment method on the NEW Stripe account, shaped like
 *   { customerId: "cus_new...", paymentMethodId: "pm_new...", chargeable: bool }.
 *
 * Returns [action, reason]. action is one of "skip", "missing", "recreate".
 */
export function decide(subscription, newToken) {
  if (!ACTIVE_SUB_STATUSES.has(subscription.status)) {
    return ["skip", "subscription is not active or on-hold"];
  }

  const oldCustomer = subscription._stripe_customer_id;
  const oldSource = subscription._stripe_source_id;

  if (!oldCustomer) {
    return ["skip", "no old Stripe customer recorded, nothing to migrate"];
  }

  if (!newToken) {
    return ["missing", "no valid payment method on the new Stripe account yet"];
  }

  if (!newToken.chargeable) {
    return ["missing", "customer has a payment method on the new account but it is not chargeable"];
  }

  if (newToken.customerId === oldCustomer && newToken.paymentMethodId === oldSource) {
    return ["skip", "subscription already points at the current token"];
  }

  return ["recreate", "old token is gone, pointing subscription at the new customer and payment method"];
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function findNewToken(email) {
  const customers = await stripe.customers.list({ email, limit: 1 });
  if (!customers.data.length) return null;
  const customer = customers.data[0];
  const methods = await stripe.paymentMethods.list({ customer: customer.id, type: "card", limit: 1 });
  if (!methods.data.length) return null;
  const pm = methods.data[0];
  const chargeable = pm.card?.checks?.cvc_check !== "fail";
  return { customerId: customer.id, paymentMethodId: pm.id, chargeable };
}

async function* activeSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,on-hold&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function applyNewToken(subId, newToken) {
  await woo(`/subscriptions/${subId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "_stripe_customer_id", value: newToken.customerId },
        { key: "_stripe_source_id", value: newToken.paymentMethodId },
      ],
    }),
  });
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Recreated after the Stripe account move. Now billing ` +
            `${newToken.customerId} / ${newToken.paymentMethodId} on the new account.`,
    }),
  });
}

export async function run() {
  let recreated = 0;
  let missing = 0;

  for await (const sub of activeSubscriptions()) {
    const meta = Object.fromEntries((sub.meta_data || []).map((m) => [m.key, m.value]));
    const subscription = {
      status: sub.status,
      _stripe_customer_id: meta._stripe_customer_id,
      _stripe_source_id: meta._stripe_source_id,
    };
    const email = sub.billing?.email;
    const newToken = email ? await findNewToken(email) : null;
    const [action, reason] = decide(subscription, newToken);

    if (action === "skip") continue;
    if (action === "missing") {
      console.warn(`Subscription ${sub.id}: ${reason}`);
      missing++;
      continue;
    }

    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would recreate" : "recreating"}`);
    if (!DRY_RUN) await applyNewToken(sub.id, newToken);
    recreated++;
  }

  console.log(
    `Done. ${recreated} subscription(s) ${DRY_RUN ? "to recreate" : "recreated"}. ` +
    `${missing} still need a new card from the customer.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
