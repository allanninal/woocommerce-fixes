/**
 * Recompute WooCommerce customer lifetime value from real paid orders.
 *
 * WooCommerce caches a customer's lifetime value (report_customer meta and
 * the Analytics customers table) instead of summing orders on every page
 * view. That cache can drift from reality: a refund that never re-synced,
 * an order edited after the total was cached, or a Stripe refund issued
 * from the Stripe dashboard that never reached WooCommerce at all. This
 * walks each customer's paid orders, nets out refunds using the WooCommerce
 * REST API, double checks the refund total against Stripe when a
 * PaymentIntent id is on the order, and writes the correct lifetime value
 * back onto the customer as meta. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/customer-lifetime-value-drifts/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRIFT_TOLERANCE_CENTS = Number(process.env.DRIFT_TOLERANCE_CENTS || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);
const CLV_META_KEY = "_clv_recomputed_cents";

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderTotalMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

export function orderRefundedMinor(order) {
  if (order.refunds && order.refunds.length) {
    return order.refunds.reduce((sum, r) => sum + Math.round(Math.abs(parseFloat(r.total || 0)) * 100), 0);
  }
  return Math.round(Math.abs(parseFloat(order.total_refunded || "0") || 0) * 100);
}

/**
 * Pure: sum the net value of every paid order for one customer.
 *
 * orders: array of WooCommerce order objects for a single customer.
 * stripeRefundsByOrderId: optional { [orderId]: refundedMinorUnits } to
 *   prefer Stripe's refund total over WooCommerce's cached one, when it is
 *   available and larger (Stripe is the source of truth for money moving
 *   back to the buyer).
 * Returns { totalMinor, counted, notes } where notes lists any orders where
 * WooCommerce and Stripe disagreed on the refunded amount.
 */
export function computeCustomerClv(orders, stripeRefundsByOrderId = {}) {
  let total = 0;
  let counted = 0;
  const notes = [];
  for (const order of orders) {
    if (!PAID_STATUSES.has(order.status)) continue;
    const wooRefunded = orderRefundedMinor(order);
    const stripeRefunded = stripeRefundsByOrderId[order.id];
    let refunded = wooRefunded;
    if (stripeRefunded !== undefined && stripeRefunded > wooRefunded) {
      notes.push(
        `order ${order.id}: Stripe shows ${stripeRefunded} minor units refunded, ` +
        `WooCommerce cache shows ${wooRefunded}; using Stripe's figure`
      );
      refunded = stripeRefunded;
    }
    const net = Math.max(0, orderTotalMinor(order) - refunded);
    total += net;
    counted += 1;
  }
  return { totalMinor: total, counted, notes };
}

/**
 * Pure: compare WooCommerce's cached lifetime value to the recomputed one.
 *
 * customer: object with at least total_spent (WooCommerce's cached string,
 *   the same field the Analytics report and the customer list show).
 * Returns [action, reason]. action is one of "ok", "drift", "no_orders".
 */
export function decide(customer, computedTotalMinor, toleranceCents = DRIFT_TOLERANCE_CENTS) {
  const cachedMinor = Math.round(parseFloat(customer.total_spent || 0) * 100);
  if (computedTotalMinor === 0 && cachedMinor === 0) {
    return ["no_orders", "no paid orders and no cached value"];
  }
  if (Math.abs(cachedMinor - computedTotalMinor) <= toleranceCents) {
    return ["ok", "cached lifetime value matches recomputed orders"];
  }
  const direction = cachedMinor > computedTotalMinor ? "higher" : "lower";
  return [
    "drift",
    `cached lifetime value (${cachedMinor}) is ${direction} than the recomputed ` +
    `total from paid orders (${computedTotalMinor})`,
  ];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* listCustomers() {
  let page = 1;
  while (true) {
    const batch = await woo(`/customers?per_page=50&page=${page}&orderby=id`);
    if (!batch.length) return;
    for (const customer of batch) yield customer;
    page++;
  }
}

async function* listOrdersForCustomer(customerId) {
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?customer=${customerId}&per_page=100&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function getStripeRefundedMinor(order) {
  const intentId = intentIdOf(order);
  if (!intentId) return undefined;
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge"] });
  } catch {
    return undefined;
  }
  const charge = intent.latest_charge;
  if (!charge || typeof charge !== "object") return undefined;
  return charge.amount_refunded;
}

async function writeLifetimeValue(customerId, totalMinor) {
  const dollars = (totalMinor / 100).toFixed(2);
  await woo(`/customers/${customerId}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: CLV_META_KEY, value: dollars }] }),
  });
}

export async function run() {
  let drifted = 0;
  let checked = 0;
  for await (const customer of listCustomers()) {
    const orders = [];
    for await (const order of listOrdersForCustomer(customer.id)) orders.push(order);
    const stripeRefunds = {};
    for (const order of orders) {
      if (PAID_STATUSES.has(order.status)) {
        const refunded = await getStripeRefundedMinor(order);
        if (refunded !== undefined) stripeRefunds[order.id] = refunded;
      }
    }
    const { totalMinor, counted, notes } = computeCustomerClv(orders, stripeRefunds);
    checked++;
    const [action, reason] = decide(customer, totalMinor);
    for (const note of notes) console.log(`Customer ${customer.id}: ${note}`);
    if (action !== "drift") continue;
    console.warn(
      `Customer ${customer.id} (${counted} paid orders): ${reason}. ${DRY_RUN ? "would write" : "writing"}`
    );
    if (!DRY_RUN) await writeLifetimeValue(customer.id, totalMinor);
    drifted++;
  }
  console.log(`Done. Checked ${checked} customer(s). ${drifted} ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
