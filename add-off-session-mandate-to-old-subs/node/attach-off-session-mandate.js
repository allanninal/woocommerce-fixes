/**
 * Attach a valid off session mandate to old WooCommerce Subscriptions orders.
 *
 * Subscriptions created before Strong Customer Authentication (SCA) became the
 * norm often saved a card as a plain Stripe Source, or as a PaymentMethod that
 * was only ever confirmed on session (the shopper was on the checkout page).
 * Stripe requires an off session mandate before it will let a merchant charge a
 * saved PaymentMethod without the customer present. Without one, the renewal
 * PaymentIntent comes back with status requires_action and the subscription
 * goes on-hold.
 *
 * This walks active subscriptions, reads the saved PaymentMethod from the
 * parent order, and for any PaymentMethod that has never completed an off
 * session confirmation, runs a zero amount off session SetupIntent to attach a
 * mandate. Read only by default (DRY_RUN=true).
 *
 * Guide: https://www.allanninal.dev/woocommerce/add-off-session-mandate-to-old-subs/
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

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function decide(subscription, paymentMethod) {
  if (!ACTIVE_SUB_STATUSES.has(subscription.status)) {
    return ["skip", "subscription is not active or on-hold"];
  }
  if (!paymentMethod) {
    return ["no_payment_method", "no saved PaymentMethod on the parent order"];
  }
  if (!["card", "sepa_debit", "us_bank_account"].includes(paymentMethod.type)) {
    return ["skip", "payment method type does not support an off session mandate"];
  }
  if (paymentMethod.off_session_mandate) {
    return ["ok", "already has an off session mandate"];
  }
  return ["attach_mandate", "no off session mandate found, needs one before the next renewal"];
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
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

async function* activeSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,on-hold&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function existingMandate(pm) {
  const customerId = pm.customer;
  if (!customerId) return null;
  for await (const si of stripe.setupIntents.list({ customer: customerId, limit: 20 })) {
    if (si.payment_method === pm.id && si.usage === "off_session" && si.status === "succeeded") {
      return si.id;
    }
  }
  return null;
}

async function getPaymentMethod(order) {
  const intentId = intentIdOf(order);
  if (!intentId) return null;
  const intent = await stripe.paymentIntents.retrieve(intentId);
  if (!intent.payment_method) return null;
  const pm = await stripe.paymentMethods.retrieve(intent.payment_method);
  pm.off_session_mandate = await existingMandate(pm);
  return pm;
}

async function attachMandate(order, paymentMethod) {
  const setupIntent = await stripe.setupIntents.create({
    customer: paymentMethod.customer,
    payment_method: paymentMethod.id,
    usage: "off_session",
    confirm: true,
    off_session: true,
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Attached an off session mandate to PaymentMethod ${paymentMethod.id} via ` +
            `SetupIntent ${setupIntent.id}. Future renewals can now charge this card ` +
            `without the customer present.`,
    }),
  });
  return setupIntent;
}

export async function run() {
  let attached = 0;
  for await (const sub of activeSubscriptions()) {
    const parentOrderId = sub.parent_id || sub.id;
    const order = await woo(`/orders/${parentOrderId}`);
    if (!order) {
      console.warn(`Subscription ${sub.id} has no matching parent order ${parentOrderId}`);
      continue;
    }
    const paymentMethod = await getPaymentMethod(order);
    const [action, reason] = decide(sub, paymentMethod);
    if (action === "skip" || action === "ok") continue;
    if (action === "no_payment_method") {
      console.warn(`Subscription ${sub.id}: ${reason}`);
      continue;
    }
    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would attach" : "attaching"}`);
    if (!DRY_RUN) await attachMandate(order, paymentMethod);
    attached++;
  }
  console.log(`Done. ${attached} subscription(s) ${DRY_RUN ? "need a mandate" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
