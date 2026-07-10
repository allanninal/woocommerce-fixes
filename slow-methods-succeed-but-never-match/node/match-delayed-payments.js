/**
 * Match SOFORT, Klarna, and other delayed methods that succeeded after checkout
 * to the WooCommerce order they belong to. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/slow-methods-succeed-but-never-match/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 72);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Payment method types that confirm asynchronously, sometimes hours after checkout.
const DELAYED_METHODS = new Set(["sofort", "klarna", "sepa_debit", "bancontact", "ideal"]);
const PAID_STATUSES = new Set(["processing", "completed"]);
const CLOSED_STATUSES = new Set(["cancelled", "refunded", "failed", "trash"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

export async function* recentSucceededDelayed(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    if (intent.status !== "succeeded") continue;
    const methods = intent.payment_method_types || [];
    if (methods.some((m) => DELAYED_METHODS.has(m))) yield intent;
  }
}

export async function getOrder(orderId) {
  return woo(`/orders/${orderId}`);
}

export async function findOrderByIntent(intentId) {
  const matches = await woo(`/orders?search=${encodeURIComponent(intentId)}&per_page=5`);
  return matches && matches.length ? matches[0] : null;
}

export async function resolveOrder(intent) {
  const orderId = intent.metadata.order_id;
  const order = orderId ? await getOrder(orderId) : null;
  if (order) return order;
  return findOrderByIntent(intent.id);
}

export function orderAmountMinor(order) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // need their own rounding rule, since 50.00 is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision function: no I/O, easy to unit test.
 * Returns a [action, reason] tuple where action is one of:
 * "fix", "skip", "mismatch", "orphan".
 */
export function decide(order, intent) {
  if (intent.status !== "succeeded") return ["skip", "intent not succeeded"];
  if (!order) return ["orphan", "order not found"];
  if (PAID_STATUSES.has(order.status)) return ["skip", "order already paid"];
  if (CLOSED_STATUSES.has(order.status)) return ["skip", "order already closed"];
  if ((order.currency || "").toLowerCase() !== (intent.currency || "").toLowerCase()) {
    return ["mismatch", "currency does not match"];
  }
  if (Math.abs(orderAmountMinor(order) - intent.amount_received) > 1) {
    return ["mismatch", "amount does not match"];
  }
  return ["fix", "delayed method succeeded, order never caught up"];
}

export async function markProcessing(orderId, intent) {
  const chargeId = intent.latest_charge || intent.id;
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({
      status: "processing",
      transaction_id: chargeId,
      meta_data: [{ key: "_stripe_intent_id", value: intent.id }],
    }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Matched to Stripe PaymentIntent ${intent.id} (${intent.payment_method_types}), ` +
            `which confirmed after checkout. Marked processing by the reconciler.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const intent of recentSucceededDelayed(LOOKBACK_HOURS)) {
    const order = await resolveOrder(intent);
    const orderId = order ? order.id : intent.metadata.order_id;
    const [action, reason] = decide(order, intent);
    if (action === "orphan") { console.warn(`Intent ${intent.id} has no matching order`); continue; }
    if (action === "skip" || action === "mismatch") {
      if (action === "mismatch") console.warn(`Order ${orderId}: ${reason}`);
      continue;
    }
    console.log(`Order ${orderId}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await markProcessing(orderId, intent);
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
