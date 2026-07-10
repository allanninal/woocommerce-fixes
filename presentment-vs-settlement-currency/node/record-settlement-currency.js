/**
 * Record the real settlement currency and amount behind each cross-currency order.
 *
 * A buyer can check out in one currency (the presentment currency, what WooCommerce
 * shows and stores as the order total) while Stripe actually settles the charge into
 * your payout currency (the settlement currency) at its own exchange rate. WooCommerce
 * never sees that conversion, so your order total and your accounting books disagree
 * with what Stripe actually paid out. This walks recent paid orders, reads the Stripe
 * balance transaction behind each charge, and when the presentment currency does not
 * match the settlement currency, writes the settled amount, currency, and exchange
 * rate onto the order as meta so reports reconcile. It only writes orders that do not
 * already have the settlement meta recorded, so it is safe to run again and again.
 * Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/presentment-vs-settlement-currency/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const SETTLEMENT_META_KEY = "_stripe_settlement_amount";
const SETTLEMENT_CURRENCY_META_KEY = "_stripe_settlement_currency";
const EXCHANGE_RATE_META_KEY = "_stripe_exchange_rate";
const PAID_STATUSES = new Set(["processing", "completed"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function hasSettlementRecorded(order) {
  return (order.meta_data || []).some((m) => m.key === SETTLEMENT_META_KEY);
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision: what to do with this order given its Stripe balance transaction.
 *
 * balanceTransaction looks like a Stripe BalanceTransaction: it carries the settled
 * `amount` and `currency` (the payout currency) plus, when the charge was presented
 * in a different currency, an `exchange_rate`. The presentment amount and currency
 * live on the order itself (order.total, order.currency).
 */
export function decide(order, balanceTransaction) {
  if (!PAID_STATUSES.has(order.status)) return ["skip", "order not in a paid state"];
  if (hasSettlementRecorded(order)) return ["skip", "settlement already recorded"];
  if (!balanceTransaction) return ["orphan", "no Stripe balance transaction found for a paid order"];

  const settlementCurrency = balanceTransaction.currency;
  const presentmentCurrency = order.currency;

  if (settlementCurrency.toLowerCase() === presentmentCurrency.toLowerCase()) {
    return ["same-currency", "presentment and settlement currency match, nothing to reconcile"];
  }

  const exchangeRate = balanceTransaction.exchange_rate;
  if (!exchangeRate) {
    return ["mismatch", "currencies differ but Stripe reported no exchange rate"];
  }

  return ["record", "presentment and settlement currency differ, recording the real settled amount"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getBalanceTransaction(intentId) {
  if (!intentId) return null;
  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge.balance_transaction"] });
  } catch {
    return null;
  }
  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string") return null;
  const bt = charge.balance_transaction;
  if (!bt || typeof bt === "string") return null;
  return bt;
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

async function recordSettlement(orderId, balanceTransaction) {
  const note =
    `Recorded settlement: ${(balanceTransaction.amount / 100).toFixed(2)} ` +
    `${balanceTransaction.currency.toUpperCase()} at exchange rate ` +
    `${balanceTransaction.exchange_rate}. The order total is in a different ` +
    `presentment currency than what Stripe actually settled.`;
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: SETTLEMENT_META_KEY, value: balanceTransaction.amount },
        { key: SETTLEMENT_CURRENCY_META_KEY, value: balanceTransaction.currency },
        { key: EXCHANGE_RATE_META_KEY, value: String(balanceTransaction.exchange_rate) },
      ],
    }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export async function run() {
  let recorded = 0;
  for await (const order of paidOrders()) {
    const balanceTransaction = await getBalanceTransaction(intentIdOf(order));
    const [action, reason] = decide(order, balanceTransaction);
    if (action === "orphan") { console.warn(`Order ${order.id}: ${reason}`); continue; }
    if (action === "skip" || action === "same-currency" || action === "mismatch") {
      if (action === "mismatch") console.warn(`Order ${order.id}: ${reason}`);
      continue;
    }
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would record" : "recording"}`);
    if (!DRY_RUN) await recordSettlement(order.id, balanceTransaction);
    recorded++;
  }
  console.log(`Done. ${recorded} order(s) ${DRY_RUN ? "to record" : "recorded"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
