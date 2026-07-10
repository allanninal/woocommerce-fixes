/**
 * Restore WooCommerce orders that a late Stripe failure event reverted to failed.
 *
 * Sometimes a charge.failed event for an earlier attempt arrives AFTER the payment
 * succeeded, and the gateway flips a good order to failed or cancelled. Stripe is
 * the source of truth: if it shows the PaymentIntent succeeded with a matching
 * amount, the order should be paid. This finds those reverted orders and moves them
 * back to Processing. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/late-failure-reverts-paid-order/
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

const REVERTED_STATUSES = new Set(["failed", "cancelled"]);

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

export function decide(order, intent) {
  if (intent.status !== "succeeded") return ["skip", "intent not succeeded"];
  if (!order) return ["orphan", "order not found"];
  if (!REVERTED_STATUSES.has(order.status)) return ["skip", "order not in a failed state"];
  if (Math.abs(orderAmountMinor(order) - intent.amount_received) > 1) {
    return ["mismatch", "amount does not match"];
  }
  return ["restore", "paid in Stripe but order was reverted to failed"];
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

async function* recentSucceeded(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    if (intent.status === "succeeded" && intent.metadata.order_id) yield intent;
  }
}

async function restore(orderId, intent) {
  const chargeId = intent.latest_charge || intent.id;
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "processing", transaction_id: chargeId }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Restored to processing. Stripe PaymentIntent ${intent.id} is succeeded, ` +
            `so a late failure event had reverted a paid order.`,
    }),
  });
}

export async function run() {
  let restored = 0;
  for await (const intent of recentSucceeded(LOOKBACK_HOURS)) {
    const orderId = intent.metadata.order_id;
    const order = await woo(`/orders/${orderId}`);
    const [action, reason] = decide(order, intent);
    if (action === "orphan") { console.warn(`Intent ${intent.id} points to missing order ${orderId}`); continue; }
    if (action === "skip" || action === "mismatch") {
      if (action === "mismatch") console.warn(`Order ${orderId} amount mismatch: ${reason}`);
      continue;
    }
    console.log(`Order ${orderId}: ${reason}. ${DRY_RUN ? "would restore" : "restoring"}`);
    if (!DRY_RUN) await restore(orderId, intent);
    restored++;
  }
  console.log(`Done. ${restored} order(s) ${DRY_RUN ? "to restore" : "restored"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
