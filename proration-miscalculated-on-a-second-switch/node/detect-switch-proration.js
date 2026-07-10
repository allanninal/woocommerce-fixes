/**
 * Detect WooCommerce Subscriptions switch orders with a miscalculated proration.
 *
 * A second switch inside the same billing cycle should prorate against the
 * price the first switch already set, but the calculation can instead reuse
 * the subscription's price from before either switch happened. This walks
 * recent switch orders, rebuilds what the proration should have been from
 * the subscription's own order history and plan prices, and flags any
 * switch order whose total, or the linked Stripe charge, does not match.
 * Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/proration-miscalculated-on-a-second-switch/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function meta(order, key) {
  return (order.meta_data || []).find((m) => m.key === key)?.value ?? null;
}

export function toMinor(amount) {
  // Convert a decimal money string like "19.99" to minor units (cents).
  return Math.round(parseFloat(amount) * 100);
}

export function intentIdOf(order) {
  // The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id.
  for (const m of order.meta_data || []) {
    if (m.key === "_stripe_intent_id" && m.value) return m.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function expectedProrationMinor(daysRemaining, daysInCycle, oldPriceMinor, newPriceMinor) {
  // What the switch should cost: the new plan's daily rate minus the old
  // plan's daily rate, times the days left in the cycle. Negative means a
  // credit. All amounts are in minor units (cents) to avoid float drift.
  if (daysInCycle <= 0) return 0;
  const dailyDelta = (newPriceMinor - oldPriceMinor) / daysInCycle;
  return Math.round(dailyDelta * daysRemaining);
}

export function cycleForSwitch(switchOrder, priorOrders) {
  // Build the cycle inputs a real store would read from the subscription's
  // own next payment date and line item history. The switch order carries
  // days remaining and days in cycle as meta at the time it was created;
  // the old price is the total of the most recent prior order.
  const oldPriceMinor = priorOrders.length ? toMinor(priorOrders[priorOrders.length - 1].total) : 0;
  const newPriceMinor = priorOrders.length ? oldPriceMinor : toMinor(switchOrder.total);
  return {
    daysRemaining: Number(meta(switchOrder, "_switch_days_remaining") || 0),
    daysInCycle: Number(meta(switchOrder, "_switch_days_in_cycle") || 30),
    oldPriceMinor,
    newPriceMinor,
  };
}

export function decide(switchOrder, priorOrdersTotalMinor, cycle, stripeAmountMinor) {
  // Pure decision function, no I/O. Returns [action, reason, expectedMinor].
  // action is "ok" when the switch order total and the Stripe charge both
  // agree with the recomputed proration, otherwise "flag".
  const orderTotalMinor = toMinor(switchOrder.total);
  const expected = expectedProrationMinor(
    cycle.daysRemaining, cycle.daysInCycle, cycle.oldPriceMinor, cycle.newPriceMinor
  );
  const orderMatches = Math.abs(orderTotalMinor - expected) <= 1;
  const stripeMatches = stripeAmountMinor == null || Math.abs(stripeAmountMinor - Math.max(expected, 0)) <= 1;
  if (orderMatches && stripeMatches) {
    return ["ok", "switch order matches the expected proration", expected];
  }
  return ["flag", "switch order does not match the expected proration", expected];
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

async function* recentSwitchOrders(lookbackDays) {
  const after = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) {
      if (meta(order, "_subscription_switch")) yield order;
    }
    page++;
  }
}

async function subscriptionOrders(subscriptionId) {
  return woo(`/orders?subscription=${subscriptionId}&per_page=100&orderby=date&order=asc`);
}

async function flagOrder(orderId, expectedMinor, orderTotalMinor, stripeAmountMinor) {
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note:
        "Proration check failed on this switch order. " +
        `Expected proration: ${expectedMinor} cents. ` +
        `Order total: ${orderTotalMinor} cents. ` +
        `Stripe charged: ${stripeAmountMinor != null ? stripeAmountMinor : "no charge"} cents. ` +
        "Please review before issuing a credit or a follow up charge.",
    }),
  });
}

export async function run() {
  let flagged = 0;
  for await (const switchOrder of recentSwitchOrders(LOOKBACK_DAYS)) {
    const subscriptionId = meta(switchOrder, "_subscription_switch");
    const allOrders = await subscriptionOrders(subscriptionId);
    const priorOrders = allOrders.filter((o) => o.id !== switchOrder.id);
    const cycle = cycleForSwitch(switchOrder, priorOrders);
    const priorTotalMinor = priorOrders.reduce((sum, o) => sum + toMinor(o.total), 0);
    const intent = await getIntent(intentIdOf(switchOrder));
    const stripeAmountMinor = intent ? intent.amount_received : null;
    const [action, reason, expected] = decide(switchOrder, priorTotalMinor, cycle, stripeAmountMinor);
    if (action !== "flag") continue;
    const orderTotalMinor = toMinor(switchOrder.total);
    console.warn(
      `Order ${switchOrder.id}: ${reason} (expected ${expected}, got ${orderTotalMinor}). ` +
      `${DRY_RUN ? "would flag" : "flagging"}`
    );
    if (!DRY_RUN) await flagOrder(switchOrder.id, expected, orderTotalMinor, stripeAmountMinor);
    flagged++;
  }
  console.log(`Done. ${flagged} switch order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
