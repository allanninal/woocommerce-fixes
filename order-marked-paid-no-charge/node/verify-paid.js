/**
 * Flag WooCommerce orders marked paid that have no matching succeeded Stripe charge.
 *
 * An order can end up Processing or Completed without a real payment behind it: a
 * manual status change, a failed integration, or a tampered checkout. This walks
 * recent paid orders, looks up the saved Stripe PaymentIntent, and flags any order
 * whose payment is missing, not succeeded, or the wrong amount, by adding an order
 * note (and optionally moving it to on-hold). Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/order-marked-paid-no-charge/
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

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

export function decide(order, intent) {
  if (!PAID_STATUSES.has(order.status)) return ["skip", "order not in a paid state"];
  if (!intent) return ["flag", "no Stripe charge found for a paid order"];
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

async function flag(order, reason) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Payment check failed: ${reason}. This order is marked paid but Stripe does ` +
            `not confirm a matching succeeded charge. Please review.`,
    }),
  });
  if (REVIEW_HOLD) {
    await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status: "on-hold" }) });
  }
}

export async function run() {
  let flagged = 0;
  for await (const order of paidOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action !== "flag") continue;
    console.warn(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) await flag(order, reason);
    flagged++;
  }
  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
