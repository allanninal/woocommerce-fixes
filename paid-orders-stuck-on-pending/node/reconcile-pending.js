/**
 * Finish WooCommerce orders that Stripe already paid but the webhook missed.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/paid-orders-stuck-on-pending/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* recentSucceeded(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    if (intent.status === "succeeded" && intent.metadata.order_id) yield intent;
  }
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

export function decide(order, intent) {
  if (intent.status !== "succeeded") return ["skip", "intent not succeeded"];
  if (!order) return ["orphan", "order not found"];
  if (PAID_STATUSES.has(order.status)) return ["skip", "order already paid"];
  if (Math.abs(orderAmountMinor(order) - intent.amount_received) > 1) {
    return ["mismatch", "amount does not match"];
  }
  return ["fix", "paid in Stripe, still pending in Woo"];
}

async function markProcessing(orderId, intent) {
  const chargeId = intent.latest_charge || intent.id;
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "processing", transaction_id: chargeId }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Reconciled from Stripe PaymentIntent ${intent.id}. ` +
            `Payment was succeeded on Stripe. Marked processing by the reconciler.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const intent of recentSucceeded(LOOKBACK_HOURS)) {
    const orderId = intent.metadata.order_id;
    const order = await woo(`/orders/${orderId}`);
    const [action, reason] = decide(order, intent);
    if (action === "orphan") { console.warn(`Intent ${intent.id} points to missing order ${orderId}`); continue; }
    if (action === "skip" || action === "mismatch") {
      if (action === "mismatch") console.warn(`Order ${orderId} amount mismatch: ${reason}`);
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
