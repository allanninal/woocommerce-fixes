/**
 * Find and refund WooCommerce orders in a zero decimal currency (JPY and friends)
 * that were charged 100x too much on Stripe.
 *
 * Stripe expects "amount" in the smallest unit of the currency. For two decimal
 * currencies like USD that is cents, so $50.00 is 5000. Zero decimal currencies such
 * as JPY, KRW, and VND have no smaller unit, so PY5000 is just 5000, not 500000. Code
 * that always multiplies the order total by 100 before sending it to Stripe overcharges
 * every zero decimal order by a factor of 100. This walks recent orders in the given
 * currencies, compares what Stripe actually charged to what the order should have cost,
 * and refunds the difference. Read only by default. Run once, or on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/zero-decimal-currency-charged-100x/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg",
  "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

const PAID_STATUSES = new Set(["processing", "completed"]);

export function isZeroDecimal(currency) {
  return ZERO_DECIMAL_CURRENCIES.has((currency || "").toLowerCase());
}

/**
 * What Stripe's "amount" should be for this order total in this currency.
 *
 * Zero decimal currencies use the total as is (PY5000 -> 5000). Every other
 * currency uses the total times 100 (rounded) the usual way ($50.00 -> 5000).
 */
export function expectedMinorUnits(orderTotal, currency) {
  const total = parseFloat(orderTotal);
  if (isZeroDecimal(currency)) return Math.round(total);
  return Math.round(total * 100);
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision: does this order need an overcharge refund, and for how much?
 *
 * Returns [action, reason, overchargeMinor]. overchargeMinor is the amount, in
 * the intent's own minor units, that should be refunded. It is 0 unless action
 * is "refund".
 */
export function decide(order, intent) {
  if (!PAID_STATUSES.has(order.status)) return ["skip", "order not in a paid state", 0];
  if (!isZeroDecimal(order.currency)) return ["skip", "not a zero decimal currency", 0];
  if (!intent) return ["skip", "no Stripe PaymentIntent on this order", 0];
  if (intent.status !== "succeeded") return ["skip", "Stripe payment did not succeed", 0];

  const charged = intent.amount_received || 0;
  const expected = expectedMinorUnits(order.total, order.currency);
  if (charged <= expected) return ["ok", "charge matches the order total", 0];

  // A 100x overcharge lands very close to charged / 100 == expected. Require
  // that ratio (within a small tolerance) so we only touch the bug this script
  // targets, not some unrelated pricing mismatch.
  if (expected <= 0 || Math.abs(charged - expected * 100) > Math.max(1, Math.floor(expected / 100))) {
    return ["mismatch", "overcharged but not by the 100x pattern", 0];
  }

  const alreadyRefunded = intent.amount_refunded || 0;
  const overcharge = charged - expected;
  const remaining = overcharge - alreadyRefunded;
  if (remaining <= 0) return ["ok", "overcharge already refunded", 0];

  return ["refund", "charged 100x the zero decimal total", remaining];
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

async function refundOvercharge(order, intent, overchargeMinor) {
  const chargeId = intent.latest_charge || intent.id;
  await stripe.refunds.create({
    ...(chargeId === intent.id ? { payment_intent: intent.id } : { charge: chargeId }),
    amount: overchargeMinor,
    reason: "duplicate",
    metadata: { reason: "zero_decimal_currency_100x_overcharge", order_id: String(order.id) },
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Refunded a ${overchargeMinor} unit overcharge caused by treating ` +
            `${order.currency} as a two decimal currency. Stripe PaymentIntent ${intent.id}.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const order of paidOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason, overchargeMinor] = decide(order, intent);
    if (action === "mismatch") {
      console.warn(`Order ${order.id}: ${reason}`);
      continue;
    }
    if (action !== "refund") continue;
    console.warn(
      `Order ${order.id}: ${reason}. Overcharge is ${overchargeMinor} minor units. ` +
      `${DRY_RUN ? "would refund" : "refunding"}`
    );
    if (!DRY_RUN) await refundOvercharge(order, intent, overchargeMinor);
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to refund" : "refunded"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
