/**
 * Resolve WooCommerce orders stuck on 3D Secure with Stripe.
 * Complete the ones that paid, fail the old ones that never finished.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/orders-stuck-requires-action-3ds/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 48);
const THRESHOLD_HOURS = Number(process.env.THRESHOLD_HOURS || 6);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);
const WAITING = new Set(["requires_action", "requires_payment_method", "requires_confirmation", "processing"]);

export function classify(status, ageHours, thresholdHours) {
  if (status === "succeeded") return "complete";
  if (WAITING.has(status)) return ageHours >= thresholdHours ? "fail" : "wait";
  return "wait";
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

async function* candidateIntents(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    if (intent.metadata.order_id && intent.status !== "canceled") {
      const ageHours = (Date.now() / 1000 - intent.created) / 3600;
      yield { intent, ageHours };
    }
  }
}

export async function run() {
  let completed = 0, failed = 0;
  for await (const { intent, ageHours } of candidateIntents(LOOKBACK_HOURS)) {
    const orderId = intent.metadata.order_id;
    const action = classify(intent.status, ageHours, THRESHOLD_HOURS);
    if (action === "wait") continue;
    const order = await woo(`/orders/${orderId}`);
    if (!order || PAID_STATUSES.has(order.status)) continue;
    if (action === "complete") {
      console.log(`Order ${orderId}: 3DS paid later. ${DRY_RUN ? "would complete" : "completing"}`);
      if (!DRY_RUN) {
        const chargeId = intent.latest_charge || intent.id;
        await woo(`/orders/${orderId}`, { method: "PUT", body: JSON.stringify({ status: "processing", transaction_id: chargeId }) });
        await woo(`/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ note: `3D Secure payment ${intent.id} completed later. Marked processing.` }) });
      }
      completed++;
    } else if (action === "fail") {
      console.log(`Order ${orderId}: 3DS never finished. ${DRY_RUN ? "would fail" : "failing"}`);
      if (!DRY_RUN) {
        await woo(`/orders/${orderId}`, { method: "PUT", body: JSON.stringify({ status: "failed" }) });
        await woo(`/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ note: `3D Secure was never completed for ${intent.id}. Marked failed to release stock.` }) });
      }
      failed++;
    }
  }
  console.log(`Done. ${completed} completed, ${failed} failed ${DRY_RUN ? "(dry run)" : ""}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
