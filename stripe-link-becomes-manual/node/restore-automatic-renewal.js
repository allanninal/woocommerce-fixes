/**
 * Restore automatic renewal on WooCommerce Subscriptions that a Stripe Link
 * checkout left on manual renewal, but only when Stripe now shows a genuine
 * reusable payment method for that customer. Run on a schedule. Safe to run
 * again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/stripe-link-becomes-manual/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const REUSABLE_TYPES = new Set(["card", "us_bank_account", "sepa_debit"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* manualSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const sub of batch) {
      if (sub.requires_manual_renewal) yield sub;
    }
    page++;
  }
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function defaultReusablePaymentMethod(customerId) {
  if (!customerId) return null;
  let customer;
  try {
    customer = await stripe.customers.retrieve(customerId);
  } catch {
    return null;
  }
  let pmId = customer.invoice_settings && customer.invoice_settings.default_payment_method;
  if (!pmId) {
    const methods = await stripe.paymentMethods.list({ customer: customerId, limit: 1 });
    if (!methods.data.length) return null;
    pmId = methods.data[0].id;
  }
  try {
    return await stripe.paymentMethods.retrieve(pmId);
  } catch {
    return null;
  }
}

export function isReusable(paymentMethod) {
  if (!paymentMethod) return false;
  return REUSABLE_TYPES.has(paymentMethod.type);
}

export function decide(subscription, paymentMethod) {
  if (!subscription.requires_manual_renewal) return ["skip", "subscription already automatic"];
  if (!["stripe", ""].includes(subscription.payment_method)) {
    return ["skip", "not billed through the Stripe gateway"];
  }
  if (!isReusable(paymentMethod)) {
    return ["keep_manual", "no reusable payment method on the Stripe customer"];
  }
  return ["repair", "reusable payment method found, safe to re-enable automatic renewal"];
}

async function reEnableAutomatic(subscriptionId, parentOrderId, paymentMethod) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ requires_manual_renewal: false, payment_method: "stripe" }),
  });
  await woo(`/orders/${parentOrderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Automatic renewal restored. Stripe customer now has a reusable ` +
            `${paymentMethod.type} payment method on file, so the Link checkout ` +
            `fallback to manual renewal was cleared by the repair job.`,
    }),
  });
}

export async function run() {
  let repaired = 0;
  for await (const sub of manualSubscriptions()) {
    const parentOrderId = sub.parent_id;
    const order = parentOrderId ? await woo(`/orders/${parentOrderId}`) : null;
    let paymentMethod = null;
    if (order) {
      const intent = await getIntent(intentIdOf(order));
      const customerId = intent && intent.customer;
      paymentMethod = await defaultReusablePaymentMethod(customerId);
    }
    const [action, reason] = decide(sub, paymentMethod);
    if (action !== "repair") {
      if (action === "keep_manual") console.log(`Subscription ${sub.id}: ${reason}`);
      continue;
    }
    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would repair" : "repairing"}`);
    if (!DRY_RUN) await reEnableAutomatic(sub.id, parentOrderId, paymentMethod);
    repaired++;
  }
  console.log(`Done. ${repaired} subscription(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
