/**
 * Find WooCommerce subscriptions whose saved Stripe payment method was detached.
 *
 * A saved card lives on Stripe as a PaymentMethod attached to a Customer. If that
 * PaymentMethod gets detached, by the shopper removing it in a self-service portal,
 * by a cleanup script that ran against the wrong customer, or by a support agent
 * clearing "duplicate" cards, the next renewal fails with a generic decline and the
 * subscription goes on-hold. Stripe will not let you reattach a PaymentMethod once
 * it is detached, so there is nothing to repair automatically. This script only
 * detects the problem and flags the subscription so a human can ask the shopper
 * for a new card.
 *
 * It walks subscriptions that are active or on-hold, reads the PaymentIntent id
 * from the latest renewal order's meta (_stripe_intent_id, falling back to
 * transaction_id), asks Stripe for the payment_method that PaymentIntent tried to
 * use, and checks whether that PaymentMethod is still attached to the
 * subscription's Stripe customer. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/payment-method-detached/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ACTIVE_STATUSES = new Set(["active", "on-hold"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision function. No I/O.
 *
 * subscription: object with at least "id" and "status".
 * renewalOrder: the subscription's most recent renewal order object, or null
 *               if there is no renewal order yet.
 * paymentMethod: the Stripe PaymentMethod object the renewal tried to charge,
 *                or null if it could not be found on Stripe at all.
 */
export function decide(subscription, renewalOrder, paymentMethod) {
  if (!ACTIVE_STATUSES.has(subscription.status)) {
    return ["skip", "subscription is not active or on-hold"];
  }
  if (!renewalOrder) return ["skip", "no renewal order to check yet"];
  if (!intentIdOf(renewalOrder)) return ["skip", "renewal order has no saved PaymentIntent id"];
  if (!paymentMethod) return ["flag", "saved payment method no longer exists on Stripe"];
  if (!paymentMethod.customer) return ["flag", "payment method is detached from any Stripe customer"];
  const expectedCustomer = subscription.stripe_customer_id;
  if (expectedCustomer && paymentMethod.customer !== expectedCustomer) {
    return ["flag", "payment method is attached to a different Stripe customer"];
  }
  return ["ok", "payment method is attached and matches the subscription"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getPaymentMethodForIntent(intentId) {
  if (!intentId) return null;
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
  const pmId = intent.payment_method || intent.last_payment_error?.payment_method?.id;
  if (!pmId) return null;
  try {
    return await stripe.paymentMethods.retrieve(pmId);
  } catch {
    return null;
  }
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

async function latestRenewalOrder(subscriptionId) {
  const batch = await woo(
    `/orders?subscription_renewal=${subscriptionId}&per_page=1&orderby=date&order=desc`
  );
  return batch[0] || null;
}

async function flag(subscription, reason) {
  await woo(`/orders/${subscription.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Payment method check failed: ${reason}. The saved card can no longer ` +
            `be charged automatically. Please ask the customer to add a new payment method.`,
    }),
  });
  await woo(`/orders/${subscription.id}`, { method: "PUT", body: JSON.stringify({ status: "on-hold" }) });
}

export async function run() {
  let flagged = 0;
  for await (const subscription of activeSubscriptions()) {
    const renewalOrder = await latestRenewalOrder(subscription.id);
    const intentId = renewalOrder ? intentIdOf(renewalOrder) : null;
    const paymentMethod = await getPaymentMethodForIntent(intentId);
    const [action, reason] = decide(subscription, renewalOrder, paymentMethod);
    if (action !== "flag") continue;
    console.warn(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) await flag(subscription, reason);
    flagged++;
  }
  console.log(`Done. ${flagged} subscription(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
