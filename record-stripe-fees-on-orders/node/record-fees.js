/**
 * Record the Stripe fee and net amount on each WooCommerce order.
 *
 * WooCommerce reports show the gross order total, not what you actually kept after
 * Stripe's processing fee. This walks recent paid orders, reads the Stripe balance
 * transaction behind each charge, and saves the fee and net onto the order as meta,
 * so your reporting can show real profit. It only writes to orders that do not have
 * the fee recorded yet, so it is safe to run again and again. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/record-stripe-fees-on-orders/
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

const FEE_META_KEY = "_stripe_fee";
const NET_META_KEY = "_stripe_net";

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function hasFeeRecorded(order) {
  return (order.meta_data || []).some((m) => m.key === FEE_META_KEY);
}

export function feeAndNet(balanceTransaction) {
  if (!balanceTransaction) return null;
  const { fee, net } = balanceTransaction;
  if (fee == null || net == null) return null;
  return { fee: Math.round(fee) / 100, net: Math.round(net) / 100 };
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function balanceFor(intentId) {
  if (!intentId) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge.balance_transaction"] });
    const charge = pi.latest_charge;
    if (!charge || typeof charge === "string") return null;
    return charge.balance_transaction;
  } catch {
    return null;
  }
}

async function saveFee(orderId, values) {
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: FEE_META_KEY, value: values.fee },
        { key: NET_META_KEY, value: values.net },
      ],
    }),
  });
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

export async function run() {
  let saved = 0;
  for await (const order of paidOrders()) {
    if (hasFeeRecorded(order)) continue;
    const values = feeAndNet(await balanceFor(intentIdOf(order)));
    if (values === null) continue;
    console.log(`Order ${order.id} fee ${values.fee} net ${values.net}. ${DRY_RUN ? "would save" : "saving"}`);
    if (!DRY_RUN) await saveFee(order.id, values);
    saved++;
  }
  console.log(`Done. ${saved} order(s) ${DRY_RUN ? "to record" : "recorded"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
