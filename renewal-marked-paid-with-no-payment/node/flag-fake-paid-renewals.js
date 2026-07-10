/**
 * Flag WooCommerce Subscriptions renewal orders marked paid with no matching
 * Stripe charge behind them.
 *
 * A caching bug or a race between two renewal attempts can let the renewal
 * handler take its success path, marking the order paid and extending the
 * subscription, without a succeeded PaymentIntent ever existing in Stripe.
 * This walks recent renewal orders, looks up the saved PaymentIntent, and
 * flags any renewal whose payment is missing, not succeeded, or the wrong
 * amount, by adding an order note (and optionally moving it to on-hold).
 * Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/renewal-marked-paid-with-no-payment/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const REVIEW_HOLD = (process.env.REVIEW_HOLD || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

/** True when the order carries the WooCommerce Subscriptions renewal meta key. */
export function isRenewal(order) {
  return (order.meta_data || []).some((m) => m.key === "_subscription_renewal");
}

/** The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id. */
export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/** Order total in cents. Two decimal currencies only. */
export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision: does this renewal order need to be flagged?
 * order: an object shaped like the WooCommerce REST API order resource.
 * intent: an object shaped like a Stripe PaymentIntent, or null if none was found.
 * Returns [action, reason] where action is one of "skip", "flag", or "ok".
 */
export function decide(order, intent) {
  if (!PAID_STATUSES.has(order.status)) return ["skip", "renewal not in a paid state"];
  if (!intent) return ["flag", "no Stripe charge found for a paid renewal"];
  if (intent.status !== "succeeded") return ["flag", "Stripe shows the payment not succeeded"];
  if (Math.abs(orderAmountMinor(order) - (intent.amount_received || 0)) > 1) {
    return ["flag", "amount does not match the Stripe charge"];
  }
  return ["ok", "matches a succeeded Stripe charge"];
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

async function* paidRenewalOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) {
      if (isRenewal(order)) yield order;
    }
    page++;
  }
}

async function flag(order, reason) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Renewal payment check failed: ${reason}. This renewal is marked paid but Stripe ` +
            `does not confirm a matching succeeded charge. Please review.`,
    }),
  });
  if (REVIEW_HOLD) {
    await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status: "on-hold" }) });
  }
}

export async function run() {
  let flagged = 0;
  for await (const order of paidRenewalOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action !== "flag") continue;
    console.warn(`Renewal ${order.id}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) await flag(order, reason);
    flagged++;
  }
  console.log(`Done. ${flagged} renewal(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
