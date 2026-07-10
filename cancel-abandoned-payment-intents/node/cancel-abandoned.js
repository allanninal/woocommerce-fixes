/**
 * Cancel abandoned Stripe PaymentIntents and their pending WooCommerce orders.
 * Never touches a real payment. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/cancel-abandoned-payment-intents/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 168);
const THRESHOLD_HOURS = Number(process.env.THRESHOLD_HOURS || 12);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ABANDONED = new Set(["requires_payment_method", "requires_confirmation"]);

export function isAbandoned(intent, ageHours, thresholdHours) {
  if (!ABANDONED.has(intent.status)) return false;
  if (intent.last_payment_error) return false;
  return ageHours >= thresholdHours;
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

async function* intentsWithAge(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    if (intent.metadata.order_id) {
      const ageHours = (Date.now() / 1000 - intent.created) / 3600;
      yield { intent, ageHours };
    }
  }
}

export async function run() {
  let cancelled = 0;
  for await (const { intent, ageHours } of intentsWithAge(LOOKBACK_HOURS)) {
    if (!isAbandoned(intent, ageHours, THRESHOLD_HOURS)) continue;
    const orderId = intent.metadata.order_id;
    console.log(`Intent ${intent.id} (order ${orderId}) abandoned. ${DRY_RUN ? "would cancel" : "cancelling"}`);
    if (!DRY_RUN) {
      await stripe.paymentIntents.cancel(intent.id, { cancellation_reason: "abandoned" });
      const order = await woo(`/orders/${orderId}`);
      if (order && order.status === "pending") {
        await woo(`/orders/${orderId}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
        await woo(`/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ note: `Checkout was abandoned. Cancelled the Stripe PaymentIntent ${intent.id} and the order to release stock.` }) });
      }
    }
    cancelled++;
  }
  console.log(`Done. ${cancelled} abandoned intent(s) ${DRY_RUN ? "to cancel" : "cancelled"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
