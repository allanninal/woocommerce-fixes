/**
 * Push a WooCommerce card change to the Stripe customer's default payment method.
 *
 * A shopper updates their card on a WooCommerce order (or through My Account, Change
 * payment method) and the new card is charged just fine on that one order. But the
 * Stripe customer record is never told the card changed, so `invoice_settings.
 * default_payment_method` still points at the old card. The next Stripe Billing
 * renewal, or the next off-session charge, reaches for the old card and fails.
 *
 * This walks recent paid orders, reads the PaymentIntent saved on each one, and
 * pushes its payment method onto the Stripe customer as the new default whenever it
 * differs from what Stripe already has on file. Safe to run again and again. Dry
 * run by default.
 *
 * Guide: https://www.allanninal.dev/woocommerce/push-a-card-change-to-stripe/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function customerIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_customer_id" && meta.value) return meta.value;
  }
  return null;
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision function. No I/O. Returns [action, reason].
 * Actions: skip, orphan, mismatch, push, already-synced.
 */
export function decide(order, intent, customer) {
  if (!PAID_STATUSES.has(order.status)) return ["skip", "order not in a paid state"];
  if (!intent) return ["orphan", "no PaymentIntent saved on this order"];
  if (intent.status !== "succeeded") return ["skip", "intent not succeeded"];
  if (!intent.payment_method) return ["orphan", "intent has no payment_method attached"];
  if (Math.abs(orderAmountMinor(order) - (intent.amount_received || 0)) > 1) {
    return ["mismatch", "amount does not match the order, skipping to be safe"];
  }
  if (!customer) return ["orphan", "no Stripe customer found for this order"];
  const currentDefault = (customer.invoice_settings || {}).default_payment_method;
  if (currentDefault === intent.payment_method) {
    return ["already-synced", "Stripe default payment method already matches"];
  }
  return ["push", "order paid with a card Stripe does not have as the default yet"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function getCustomer(customerId) {
  if (!customerId) return null;
  try {
    return await stripe.customers.retrieve(customerId);
  } catch {
    return null;
  }
}

async function* paidOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function pushDefault(customerId, paymentMethodId) {
  // Make sure the payment method is attached to this customer before it can be
  // set as the default. Attaching an already attached payment method is a no-op.
  try {
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
  } catch (err) {
    if (!String(err.message || "").includes("already been attached")) throw err;
  }
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}

async function noteOrder(orderId, paymentMethodId) {
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Pushed the new card to Stripe as the default payment method ` +
            `(${paymentMethodId}). Future renewals will use this card.`,
    }),
  });
}

export async function run() {
  let pushed = 0;
  for await (const order of paidOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const customerId = customerIdOf(order);
    const customer = await getCustomer(customerId);
    const [action, reason] = decide(order, intent, customer);
    if (action === "skip" || action === "already-synced") continue;
    if (action === "orphan" || action === "mismatch") {
      console.warn(`Order ${order.id}: ${reason}`);
      continue;
    }
    const paymentMethodId = intent.payment_method;
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would push" : "pushing"}`);
    if (!DRY_RUN) {
      await pushDefault(customerId, paymentMethodId);
      await noteOrder(order.id, paymentMethodId);
    }
    pushed++;
  }
  console.log(`Done. ${pushed} order(s) ${DRY_RUN ? "to push" : "pushed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
