/**
 * Flag WooCommerce orders whose total does not match the Stripe charge behind them.
 *
 * A partial refund applied only on one side, a currency rounding difference, a coupon
 * that changed the order after the PaymentIntent was created, or a manual edit to the
 * order total can all leave the WooCommerce order total and the Stripe PaymentIntent
 * amount disagreeing. This walks recent paid orders, reads the saved PaymentIntent id
 * from order meta `_stripe_intent_id` (falling back to `transaction_id`), and flags any
 * order whose amount drifts from what Stripe actually captured, by adding an order note.
 * Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/amount-does-not-match-the-order/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const MISMATCH_TOLERANCE_MINOR = Number(process.env.MISMATCH_TOLERANCE_MINOR || 1);
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
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since Math.round(x * 100) is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

export function capturedAmountMinor(intent) {
  return intent.amount_received ?? intent.amount ?? 0;
}

export function decide(order, intent, toleranceMinor = MISMATCH_TOLERANCE_MINOR) {
  if (!PAID_STATUSES.has(order.status)) return ["skip", "order not in a paid state"];
  if (!intent) return ["skip", "no Stripe PaymentIntent id on this order"];
  if (intent.status !== "succeeded") {
    return ["skip", "intent not succeeded, amount comparison does not apply yet"];
  }
  const orderMinor = orderAmountMinor(order);
  const chargedMinor = capturedAmountMinor(intent);
  const drift = orderMinor - chargedMinor;
  if (Math.abs(drift) <= toleranceMinor) return ["ok", "order total matches the captured amount"];
  const direction = drift > 0
    ? "order total is higher than the Stripe charge"
    : "order total is lower than the Stripe charge";
  return ["flag", `amount does not match the order: ${direction} (drift ${drift} minor units)`];
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
      note: `Payment check failed: ${reason}. Please review before shipping or refunding this order.`,
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
