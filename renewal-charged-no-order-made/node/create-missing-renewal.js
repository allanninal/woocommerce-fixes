/**
 * Create the WooCommerce renewal order for a Stripe renewal charge that succeeded
 * with no order behind it.
 *
 * WooCommerce Subscriptions is supposed to create a renewal order first and then
 * charge it through Stripe. If that scheduled action errors out partway, the charge
 * can still succeed on Stripe while no renewal order was ever written for it. This
 * walks recent succeeded renewal PaymentIntents, checks whether the subscription
 * already has a matching renewal order, and creates the missing order when it does
 * not. Dry run by default. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/renewal-charged-no-order-made/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 48);
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

async function* recentRenewalCharges(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    if (intent.status === "succeeded" && intent.metadata.subscription_id) yield intent;
  }
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

async function hasOrderForIntent(subscription, intentId) {
  const renewalIds = (subscription.related_orders && subscription.related_orders.renewal) || [];
  for (const relatedId of renewalIds) {
    const order = await woo(`/orders/${relatedId}`);
    if (order && intentIdOf(order) === intentId) return true;
  }
  return false;
}

export function amountMinorFromDecimal(amountStr) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // need their own handling, since multiplying by 100 is wrong for those.
  return Math.round(parseFloat(amountStr) * 100);
}

/**
 * Pure decision function: no I/O, easy to unit test.
 *
 * Returns an [action, reason] tuple where action is one of:
 *   "skip"   - do nothing (intent not succeeded, or an order already covers it)
 *   "orphan" - the subscription this charge points to does not exist
 *   "create" - a real succeeded charge has no renewal order, make one
 */
export function decide(subscription, intent, orderAlreadyExists) {
  if (intent.status !== "succeeded") return ["skip", "intent not succeeded"];
  if (!subscription) return ["orphan", "subscription not found"];
  if (orderAlreadyExists) return ["skip", "renewal order already exists for this charge"];
  return ["create", "charged on Stripe, no renewal order on file"];
}

export function buildRenewalPayload(subscription, intent) {
  const chargeId = intent.latest_charge || intent.id;
  return {
    status: "processing",
    customer_id: subscription.customer_id,
    payment_method: subscription.payment_method || "stripe",
    payment_method_title: subscription.payment_method_title || "Credit card (Stripe)",
    transaction_id: chargeId,
    line_items: (subscription.line_items || []).map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity,
    })),
    meta_data: [
      { key: "_stripe_intent_id", value: intent.id },
      { key: "_subscription_renewal", value: String(subscription.id) },
    ],
  };
}

async function createRenewalOrder(subscription, intent) {
  const order = await woo("/orders", {
    method: "POST",
    body: JSON.stringify(buildRenewalPayload(subscription, intent)),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Created after the fact from Stripe PaymentIntent ${intent.id}. ` +
            `The renewal charge succeeded on Stripe but the store never made an order for it.`,
    }),
  });
  return order;
}

export async function run() {
  let created = 0;
  for await (const intent of recentRenewalCharges(LOOKBACK_HOURS)) {
    const subId = intent.metadata.subscription_id;
    const subscription = await woo(`/subscriptions/${subId}`);
    const alreadyExists = subscription ? await hasOrderForIntent(subscription, intent.id) : false;
    const [action, reason] = decide(subscription, intent, alreadyExists);
    if (action === "orphan") { console.warn(`Intent ${intent.id} points to missing subscription ${subId}`); continue; }
    if (action === "skip") continue;
    console.log(`Subscription ${subId}: ${reason}. ${DRY_RUN ? "would create" : "creating"}`);
    if (!DRY_RUN) await createRenewalOrder(subscription, intent);
    created++;
  }
  console.log(`Done. ${created} order(s) ${DRY_RUN ? "to create" : "created"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
