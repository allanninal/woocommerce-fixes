/**
 * Attach a WooCommerce customer's saved Stripe PaymentMethod to their Stripe
 * Customer when it exists but was never attached. Run on a schedule, ahead
 * of billing. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/attach-the-payment-method/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

/** The saved Stripe PaymentIntent id lives on meta _stripe_intent_id. We use
 * it to look up the PaymentIntent, then read payment_method off it. Some
 * older orders only have a pm_ id directly on transaction_id.
 */
export function paymentMethodIdOf(order) {
  const tid = order.transaction_id || "";
  if (tid.startsWith("pm_")) return tid;
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  return null;
}

async function stripeCustomerIdOf(wcCustomerId) {
  if (!wcCustomerId) return null;
  const customer = await woo(`/customers/${wcCustomerId}`);
  for (const meta of customer?.meta_data || []) {
    if (meta.key === "_stripe_customer_id") return meta.value;
  }
  return null;
}

/** Turn whatever id we found (a pi_... or a pm_...) into a PaymentMethod
 * object read straight from Stripe. Returns null if it cannot be resolved.
 */
async function resolvePaymentMethod(rawId) {
  if (!rawId) return null;
  try {
    if (rawId.startsWith("pi_")) {
      const intent = await stripe.paymentIntents.retrieve(rawId);
      return intent.payment_method ? stripe.paymentMethods.retrieve(intent.payment_method) : null;
    }
    return await stripe.paymentMethods.retrieve(rawId);
  } catch {
    return null;
  }
}

/** Pure decision function. No I/O. Takes the Stripe Customer id the
 * WooCommerce customer should be linked to, and the PaymentMethod object
 * (with a "customer" field) as read from Stripe, and returns [action, reason].
 *
 * Actions:
 *   skip     - nothing to check or nothing to compare against
 *   ok       - already attached to the expected customer, no change needed
 *   conflict - attached to a different customer, needs a human to review
 *   attach   - unattached, safe to attach automatically
 */
export function decide(stripeCustomerId, paymentMethod) {
  if (!paymentMethod) return ["skip", "no PaymentMethod found to check"];
  if (!stripeCustomerId) return ["skip", "customer has no Stripe Customer id on file"];
  const current = paymentMethod.customer || null;
  if (current === stripeCustomerId) return ["ok", "already attached to the right customer"];
  if (current) return ["conflict", `attached to a different customer (${current})`];
  return ["attach", "unattached, safe to attach"];
}

async function attachPaymentMethod(paymentMethodId, stripeCustomerId) {
  await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId });
}

async function addNote(orderId, note) {
  await woo(`/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ note }) });
}

async function* recentOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

export async function run() {
  let fixed = 0;
  for await (const order of recentOrders()) {
    const rawId = paymentMethodIdOf(order);
    if (!rawId) continue;
    const paymentMethod = await resolvePaymentMethod(rawId);
    const stripeCustomerId = await stripeCustomerIdOf(order.customer_id);
    const [action, reason] = decide(stripeCustomerId, paymentMethod);
    if (action === "conflict") {
      console.warn(`Order ${order.id}: ${reason}. Needs a human to review.`);
      continue;
    }
    if (action === "skip" || action === "ok") continue;
    const pmId = paymentMethod.id;
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would attach" : "attaching"}`);
    if (!DRY_RUN) {
      await attachPaymentMethod(pmId, stripeCustomerId);
      await addNote(
        order.id,
        `Attached Stripe PaymentMethod ${pmId} to Stripe Customer ${stripeCustomerId}. ` +
          `It existed but was not attached, which would have blocked the next off session charge.`
      );
    }
    fixed++;
  }
  console.log(`Done. ${fixed} PaymentMethod(s) ${DRY_RUN ? "to attach" : "attached"}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
