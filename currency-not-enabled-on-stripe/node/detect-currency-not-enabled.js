/**
 * Detect WooCommerce orders that failed, or are about to fail, because their
 * currency is not enabled on the connected Stripe account.
 *
 * Stripe accounts only accept a fixed list of settlement currencies. If a store
 * adds a new store currency, a multi-currency plugin, or a manual order in a
 * currency the Stripe account was never approved for, the charge fails with an
 * error such as "currency_not_enabled" (or a related code). This script lists the
 * account's enabled currencies once, then walks recent orders and flags any whose
 * currency Stripe will reject or already rejected, before the shopper hits a
 * confusing decline. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/currency-not-enabled-on-stripe/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const REVIEW_HOLD = (process.env.REVIEW_HOLD || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Orders worth checking: still open (pending, on-hold) or already failed.
const CHECKABLE_STATUSES = new Set(["pending", "on-hold", "failed"]);

// Stripe error codes that mean the currency itself is the problem, not the card.
const CURRENCY_ERROR_CODES = new Set(["currency_not_enabled", "moto_not_supported"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderCurrency(order) {
  return (order.currency || "").toLowerCase();
}

/**
 * Pure decision function. No I/O.
 *
 * order: object with at least "status" and "currency".
 * enabledCurrencies: Set or array of lower case currency codes the Stripe account accepts.
 * intent: optional Stripe PaymentIntent object (or null if none was ever created).
 *
 * Returns [action, reason]. action is one of "skip" or "flag".
 */
export function decide(order, enabledCurrencies, intent = null) {
  if (!CHECKABLE_STATUSES.has(order.status)) {
    return ["skip", "order is not pending, on-hold, or failed"];
  }

  const currency = orderCurrency(order);
  if (!currency) return ["skip", "order has no currency set"];

  const enabled = new Set(Array.from(enabledCurrencies, (c) => c.toLowerCase()));
  const currencySupported = enabled.has(currency);

  const lastErrorCode = intent && intent.last_payment_error ? intent.last_payment_error.code : null;

  if (!currencySupported) {
    return ["flag", `currency ${currency} is not enabled on the Stripe account`];
  }

  if (lastErrorCode && CURRENCY_ERROR_CODES.has(lastErrorCode)) {
    return ["flag", `Stripe rejected the charge with ${lastErrorCode}`];
  }

  return ["skip", "currency is enabled and no currency related error was found"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getEnabledCurrencies() {
  // Stripe's capabilities are not currency specific, so the reliable source is the
  // country spec for the account's country, which lists every currency that
  // country is allowed to accept payments in.
  const account = await stripe.accounts.retrieve();
  const country = account.country || "US";
  const spec = await stripe.countrySpecs.retrieve(country);
  const supported = spec.supported_payment_currencies || [];
  return new Set(supported.map((c) => c.toLowerCase()));
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function* checkableOrders() {
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=pending,on-hold,failed&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function flag(order, reason) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Payment check failed: ${reason}. Enable this currency in the Stripe Dashboard ` +
            `under Settings, Payment methods, or refund and rebill the buyer in a supported ` +
            `currency. Please review.`,
    }),
  });
  if (REVIEW_HOLD && order.status !== "on-hold") {
    await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status: "on-hold" }) });
  }
}

export async function run() {
  const enabledCurrencies = await getEnabledCurrencies();
  console.log(`Stripe account accepts: ${Array.from(enabledCurrencies).sort().join(", ") || "(none found)"}`);
  let flagged = 0;
  for await (const order of checkableOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, enabledCurrencies, intent);
    if (action !== "flag") continue;
    console.warn(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) await flag(order, reason);
    flagged++;
  }
  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
