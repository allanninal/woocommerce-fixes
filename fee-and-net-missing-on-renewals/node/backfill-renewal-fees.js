/**
 * Backfill the Stripe fee and net on WooCommerce Subscriptions renewal orders
 * that are missing them, usually because an update stopped a fee-saving hook
 * from firing on renewals. Read only by default. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/fee-and-net-missing-on-renewals/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 90);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const FEE_META_KEY = "_stripe_fee";
const NET_META_KEY = "_stripe_net";
const PAID_STATUSES = new Set(["processing", "completed"]);

/** A renewal order carries a _subscription_renewal meta key pointing at the parent subscription. */
export function isRenewalOrder(order) {
  return (order.meta_data || []).some((m) => m.key === "_subscription_renewal");
}

export function hasFeeAndNet(order) {
  const keys = new Set((order.meta_data || []).map((m) => m.key));
  return keys.has(FEE_META_KEY) && keys.has(NET_META_KEY);
}

/** The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id. */
export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision: what should happen to this renewal order? No I/O here.
 * Returns [action, reason]. action is one of "skip", "orphan", "fix".
 */
export function decide(order, balanceTransaction) {
  if (!isRenewalOrder(order)) return ["skip", "not a renewal order"];
  if (!PAID_STATUSES.has(order.status)) return ["skip", "renewal not paid yet"];
  if (hasFeeAndNet(order)) return ["skip", "fee and net already recorded"];
  if (!intentIdOf(order)) return ["orphan", "no PaymentIntent id saved on the order"];
  if (!balanceTransaction) return ["orphan", "no balance transaction found for the charge"];
  const { fee, net } = balanceTransaction;
  if (fee == null || net == null) return ["orphan", "balance transaction missing fee or net"];
  return ["fix", "renewal paid, fee and net can be backfilled"];
}

/** Convert a minor unit amount (cents) to a 2-decimal major unit amount. */
export function toMajor(minorAmount) {
  return Math.round(minorAmount) / 100;
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function balanceTransactionFor(intentId) {
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

async function* paidRenewalOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) {
      if (isRenewalOrder(order)) yield order;
    }
    page++;
  }
}

async function saveFeeAndNet(orderId, feeMinor, netMinor) {
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: FEE_META_KEY, value: toMajor(feeMinor).toFixed(2) },
        { key: NET_META_KEY, value: toMajor(netMinor).toFixed(2) },
      ],
    }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Backfilled Stripe fee ${toMajor(feeMinor).toFixed(2)} and net ` +
            `${toMajor(netMinor).toFixed(2)} for this renewal. Recorded by the fee backfill.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  let orphans = 0;
  for await (const order of paidRenewalOrders()) {
    const bt = await balanceTransactionFor(intentIdOf(order));
    const [action, reason] = decide(order, bt);
    if (action === "orphan") {
      console.warn(`Order ${order.id}: ${reason}`);
      orphans++;
      continue;
    }
    if (action === "skip") continue;
    console.log(`Order ${order.id}: fee ${toMajor(bt.fee).toFixed(2)} net ${toMajor(bt.net).toFixed(2)}. ` +
                `${DRY_RUN ? "would save" : "saving"}`);
    if (!DRY_RUN) await saveFeeAndNet(order.id, bt.fee, bt.net);
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to backfill" : "backfilled"}, ${orphans} orphan(s) need a manual look.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
