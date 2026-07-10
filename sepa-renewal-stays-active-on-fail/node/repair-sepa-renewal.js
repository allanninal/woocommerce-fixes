/**
 * Move SEPA renewal orders to on-hold when the mandate failed after the fact.
 *
 * SEPA Direct Debit reports a PaymentIntent as processing right away, so WooCommerce
 * marks the renewal paid before the bank has actually confirmed the debit. If the
 * bank later returns it unpaid and that webhook is missed, the renewal order and the
 * subscription stay active with no real payment behind them. This walks recent paid
 * renewal orders, rereads the PaymentIntent status straight from Stripe, and moves any
 * order whose SEPA mandate truly failed to on-hold so dunning can run. Safe to run
 * again and again. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/sepa-renewal-stays-active-on-fail/
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

const PAID_STATUSES = new Set(["processing", "completed"]);
const FAILED_INTENT_STATUSES = new Set(["requires_payment_method", "canceled"]);
const ALREADY_HANDLED_STATUSES = new Set(["on-hold", "failed"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* paidRenewalOrders(lookbackDays) {
  const after = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) {
      if ((order.meta_data || []).some((m) => m.key === "_subscription_renewal")) yield order;
    }
    page++;
  }
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

export function decide(order, intent) {
  if (ALREADY_HANDLED_STATUSES.has(order.status)) return ["skip", "already moved off active"];
  if (!PAID_STATUSES.has(order.status)) return ["skip", "order not in a paid state"];
  if (!intent) return ["skip", "no PaymentIntent to check"];
  if (intent.status === "succeeded") return ["skip", "Stripe confirms the payment succeeded"];
  if (!FAILED_INTENT_STATUSES.has(intent.status)) return ["wait", "SEPA still processing, not a failure yet"];
  return ["repair", "SEPA mandate failed after the renewal was marked paid"];
}

async function markOnHold(orderId, intent) {
  await woo(`/orders/${orderId}`, { method: "PUT", body: JSON.stringify({ status: "on-hold" }) });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `SEPA mandate failed after this renewal was marked paid. ` +
            `Stripe PaymentIntent ${intent.id} now shows ${intent.status}. ` +
            `Moved to on-hold so payment retries can run.`,
    }),
  });
}

export async function run() {
  let repaired = 0;
  for await (const order of paidRenewalOrders(LOOKBACK_DAYS)) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action !== "repair") {
      if (action === "wait") console.log(`Order ${order.id}: ${reason}`);
      continue;
    }
    console.warn(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would repair" : "repairing"}`);
    if (!DRY_RUN) await markOnHold(order.id, intent);
    repaired++;
  }
  console.log(`Done. ${repaired} order(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
