/**
 * Recompute stale Stripe fee and net on refunded WooCommerce orders.
 * Reporting only. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/stripe-fee-net-stale-after-refund/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function recomputeNetFee(chargeBt, refundBts) {
  let net = chargeBt.net;
  let fee = chargeBt.fee;
  for (const bt of refundBts) {
    net += bt.net;
    fee += bt.fee;
  }
  return { net, fee };
}

export function isStale(savedMinor, trueMinor, tolerance = 1) {
  return Math.abs(savedMinor - trueMinor) > tolerance;
}

export function getMeta(order, key) {
  const hit = (order.meta_data || []).find((m) => m.key === key);
  return hit ? hit.value : null;
}

function toMinor(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* paidStripeOrders() {
  let page = 1;
  while (true) {
    const orders = await woo(`/orders?status=processing,completed,refunded&per_page=50&page=${page}`);
    if (!orders.length) return;
    for (const order of orders) yield order;
    page++;
  }
}

async function chargeNumbers(chargeId) {
  const charge = await stripe.charges.retrieve(chargeId, {
    expand: ["balance_transaction", "refunds.data.balance_transaction"],
  });
  const chargeBt = charge.balance_transaction;
  const refundBts = charge.refunds.data.map((r) => r.balance_transaction).filter(Boolean);
  return { chargeBt, refundBts };
}

export async function run() {
  let fixed = 0;
  for await (const order of paidStripeOrders()) {
    const chargeId = getMeta(order, "_stripe_charge_id");
    if (!chargeId) continue;
    const { chargeBt, refundBts } = await chargeNumbers(chargeId);
    if (!chargeBt || !refundBts.length) continue;
    const { net: trueNet, fee: trueFee } = recomputeNetFee(chargeBt, refundBts);
    const savedNet = toMinor(getMeta(order, "_stripe_net"));
    const savedFee = toMinor(getMeta(order, "_stripe_fee"));
    if (savedNet !== null && !isStale(savedNet, trueNet) && savedFee !== null && !isStale(savedFee, trueFee)) continue;
    console.log(`Order ${order.id}: net ${savedNet} -> ${trueNet}, fee ${savedFee} -> ${trueFee}. ${DRY_RUN ? "dry run" : "fixing"}`);
    if (!DRY_RUN) {
      await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ meta_data: [
        { key: "_stripe_net", value: (trueNet / 100).toFixed(2) },
        { key: "_stripe_fee", value: (trueFee / 100).toFixed(2) },
      ] }) });
      await woo(`/orders/${order.id}/notes`, { method: "POST", body: JSON.stringify({ note: `Recomputed Stripe fee and net after refund: net ${(trueNet / 100).toFixed(2)}, fee ${(trueFee / 100).toFixed(2)}.` }) });
    }
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
