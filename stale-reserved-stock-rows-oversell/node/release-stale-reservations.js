/**
 * Release WooCommerce stock reservations that have gone stale.
 *
 * WooCommerce holds stock for an order the moment checkout starts, before
 * payment is confirmed. The hold is meant to expire on its own, but a crashed
 * checkout, a timed out payment page, or a queue worker that never ran can
 * leave the order on pending or checkout-draft long after the hold window
 * passed. The reservation row is now stale: the item still looks sold to the
 * stock count, even though no payment ever completed for it, so a second
 * buyer can be oversold the same units. This walks recent unpaid orders,
 * checks each one's age and its Stripe PaymentIntent, and cancels the order
 * (which releases the stock hold) only when the hold is expired and Stripe
 * confirms no payment ever came through. Safe to run again and again. Read
 * only until DRY_RUN is turned off.
 *
 * Guide: https://www.allanninal.dev/woocommerce/stale-reserved-stock-rows-oversell/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 60);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Orders in these statuses still hold stock but have not paid.
const HOLDING_STATUSES = new Set(["pending", "checkout-draft"]);
const PAID_INTENT_STATUSES = new Set(["succeeded"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function minutesSince(isoDateString, now = Date.now()) {
  const then = new Date(isoDateString.endsWith("Z") ? isoDateString : `${isoDateString}Z`).getTime();
  return (now - then) / 60000;
}

/**
 * Pure decision: what should happen to one held order? No I/O in here.
 *
 * order        - object from GET /orders/{id} (or a plain test double)
 * intent       - Stripe PaymentIntent object, or null if the order never got one
 * ageMinutes   - minutes since the order was created (caller computes this)
 * holdMinutes  - how long a reservation is allowed to sit before it is stale
 */
export function decide(order, intent, ageMinutes, holdMinutes = HOLD_MINUTES) {
  if (!HOLDING_STATUSES.has(order.status)) {
    return ["skip", "order is not in a stock-holding status"];
  }
  if (ageMinutes < holdMinutes) {
    return ["skip", "reservation has not expired yet"];
  }
  if (intent && PAID_INTENT_STATUSES.has(intent.status)) {
    return ["paid", "Stripe shows this order was actually paid, do not touch stock"];
  }
  return ["release", "reservation is stale and was never paid"];
}

export function orderAgeMinutes(order, now = Date.now()) {
  return minutesSince(order.date_created_gmt || order.date_created, now);
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

async function* heldOrders() {
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=pending,checkout-draft&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function release(order) {
  await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Stock reservation released: this order sat unpaid past the hold window and " +
            "Stripe confirms no successful payment. Cancelled so the held stock is freed " +
            "for other buyers.",
    }),
  });
}

export async function run() {
  let released = 0;
  for await (const order of heldOrders()) {
    const ageMinutes = orderAgeMinutes(order);
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent, ageMinutes);
    if (action !== "release") {
      if (action === "paid") console.warn(`Order ${order.id}: ${reason}`);
      continue;
    }
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would release" : "releasing"}`);
    if (!DRY_RUN) await release(order);
    released++;
  }
  console.log(`Done. ${released} order(s) ${DRY_RUN ? "to release" : "released"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
