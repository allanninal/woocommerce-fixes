/**
 * Find WooCommerce orders charged twice on Stripe and refund the extra charge.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/duplicate-charge-redirect-webhook-race/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 48);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function recentCharges(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  const out = [];
  for await (const ch of stripe.charges.list({ limit: 100, created: { gte: since } })) out.push(ch);
  return out;
}

export function duplicateSets(charges) {
  const byOrder = new Map();
  for (const ch of charges) {
    const oid = (ch.metadata || {}).order_id;
    if (oid && ch.status === "succeeded" && !ch.refunded) {
      if (!byOrder.has(oid)) byOrder.set(oid, []);
      byOrder.get(oid).push(ch);
    }
  }
  const duplicates = new Map();
  for (const [oid, group] of byOrder) {
    const byAmount = new Map();
    for (const ch of group) {
      if (!byAmount.has(ch.amount)) byAmount.set(ch.amount, []);
      byAmount.get(ch.amount).push(ch);
    }
    for (const [amount, same] of byAmount) {
      if (same.length > 1) duplicates.set(`${oid}:${amount}`, { oid, same });
    }
  }
  return duplicates;
}

export function chooseExtras(same, orderTransactionId) {
  let keeper = same.find((c) => c.id === orderTransactionId);
  if (!keeper) keeper = same.reduce((a, b) => (a.created <= b.created ? a : b));
  return same.filter((c) => c.id !== keeper.id);
}

export async function run() {
  const charges = await recentCharges(LOOKBACK_HOURS);
  const duplicates = duplicateSets(charges);
  let refunded = 0;
  for (const { oid, same } of duplicates.values()) {
    const order = await woo(`/orders/${oid}`);
    const extras = chooseExtras(same, order ? order.transaction_id : null);
    for (const charge of extras) {
      console.log(`Order ${oid}: duplicate charge ${charge.id}. ${DRY_RUN ? "would refund" : "refunding"}`);
      if (!DRY_RUN) {
        await stripe.refunds.create({ charge: charge.id, reason: "duplicate" });
        await woo(`/orders/${oid}/notes`, {
          method: "POST",
          body: JSON.stringify({
            note: `Refunded duplicate Stripe charge ${charge.id} ` +
                  `(${charge.amount} ${charge.currency}). Kept the charge on the order.`,
          }),
        });
      }
      refunded++;
    }
  }
  console.log(`Done. ${refunded} duplicate charge(s) ${DRY_RUN ? "to refund" : "refunded"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
