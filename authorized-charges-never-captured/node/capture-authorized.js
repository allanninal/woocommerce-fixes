/**
 * Capture WooCommerce orders whose Stripe authorization was never captured.
 *
 * Manual-capture orders sit on hold with an authorized-but-uncaptured PaymentIntent.
 * Stripe holds an authorization for about 7 days, then releases it. This finds
 * authorized PaymentIntents whose order is still on hold, checks the amount, and
 * captures them before the hold expires. Run on a schedule. Safe to run again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/authorized-charges-never-captured/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 168);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CAPTURABLE_STATUSES = new Set(["on-hold", "pending"]);

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

export function decide(order, intent) {
  // An authorized PaymentIntent reports the held amount in `amount`, not
  // `amount_received`, because nothing has been captured yet.
  if (intent.status !== "requires_capture") return ["skip", "not awaiting capture"];
  if (!order) return ["orphan", "order not found"];
  if (!CAPTURABLE_STATUSES.has(order.status)) return ["skip", "order not awaiting capture"];
  if (Math.abs(orderAmountMinor(order) - intent.amount) > 1) {
    return ["mismatch", "amount does not match"];
  }
  return ["capture", "authorized in Stripe, still awaiting capture"];
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

async function* recentUncaptured(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    if (intent.status === "requires_capture" && intent.metadata.order_id) yield intent;
  }
}

async function capture(orderId, intent) {
  const charge = await stripe.paymentIntents.capture(intent.id);
  const chargeId = charge.latest_charge || intent.id;
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "processing", transaction_id: chargeId }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Captured Stripe PaymentIntent ${intent.id} before the authorization ` +
            `expired. Marked processing by the capture job.`,
    }),
  });
}

export async function run() {
  let captured = 0;
  for await (const intent of recentUncaptured(LOOKBACK_HOURS)) {
    const orderId = intent.metadata.order_id;
    const order = await woo(`/orders/${orderId}`);
    const [action, reason] = decide(order, intent);
    if (action === "orphan") { console.warn(`Intent ${intent.id} points to missing order ${orderId}`); continue; }
    if (action === "skip" || action === "mismatch") {
      if (action === "mismatch") console.warn(`Order ${orderId} amount mismatch: ${reason}`);
      continue;
    }
    console.log(`Order ${orderId}: ${reason}. ${DRY_RUN ? "would capture" : "capturing"}`);
    if (!DRY_RUN) await capture(orderId, intent);
    captured++;
  }
  console.log(`Done. ${captured} order(s) ${DRY_RUN ? "to capture" : "captured"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
