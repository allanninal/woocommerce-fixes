/**
 * Record Stripe disputes and chargebacks on the matching WooCommerce order.
 *
 * A chargeback pulls funds out of your Stripe balance the moment the bank files
 * it, but nothing about that event reaches WooCommerce on its own unless the
 * charge.dispute.* webhooks are wired up and processed. When they are missed,
 * the order still shows its normal paid total, the shop manager has no idea
 * money left the account, and the evidence deadline can pass unnoticed. This
 * walks recent disputes from Stripe, finds the order that was charged, and
 * writes the dispute status, amount, and evidence deadline onto the order as a
 * note (and an order meta field), so the loss and the deadline are visible
 * where the shop manager already works. Read only by default. Run on a
 * schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/disputes-not-recorded-on-the-order/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 72);
const HOLD_ON_OPEN_DISPUTE = (process.env.HOLD_ON_OPEN_DISPUTE || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Statuses where the case is still open and needs evidence or a decision.
const OPEN_STATUSES = new Set([
  "warning_needs_response",
  "warning_under_review",
  "needs_response",
  "under_review",
]);

const DISPUTE_META_KEY = "_dispute_status";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* recentDisputes(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  for await (const dispute of stripe.disputes.list({ limit: 100, created: { gte: since } })) {
    yield dispute;
  }
}

export async function intentIdOfDispute(dispute) {
  const charge = dispute.charge;
  if (charge && typeof charge === "object") return charge.payment_intent || null;
  if (typeof charge === "string") {
    try {
      const fullCharge = await stripe.charges.retrieve(charge);
      return fullCharge.payment_intent || null;
    } catch {
      return null;
    }
  }
  return null;
}

async function findOrderByIntent(intentId) {
  if (!intentId) return null;
  const byMeta = await woo(
    `/orders?meta_key=_stripe_intent_id&meta_value=${encodeURIComponent(intentId)}&per_page=1`
  );
  if (byMeta.length) return byMeta[0];
  const bySearch = await woo(`/orders?search=${encodeURIComponent(intentId)}&per_page=5`);
  return bySearch.find((order) => order.transaction_id === intentId) || null;
}

export function orderDisputeMeta(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === DISPUTE_META_KEY) return meta.value || null;
  }
  return null;
}

/**
 * Pure decision function: no I/O, just data in, action out.
 * Returns [action, reason]. action is one of "orphan", "skip", "record".
 */
export function decide(order, dispute) {
  if (!order) return ["orphan", "no order matches this dispute's PaymentIntent"];
  const recorded = orderDisputeMeta(order);
  if (recorded === dispute.status) return ["skip", "order already shows this dispute status"];
  return ["record", "dispute status changed or was never recorded"];
}

export function disputeAmountMinor(dispute) {
  // Stripe already reports dispute amounts in minor units (cents), unlike the
  // WooCommerce order total, so no conversion is needed here.
  return Number(dispute.amount);
}

export function formatNote(dispute, reason) {
  const amount = (disputeAmountMinor(dispute) / 100).toFixed(2);
  const currency = (dispute.currency || "usd").toUpperCase();
  const dueBy = dispute.evidence_details && dispute.evidence_details.due_by;
  const deadline = dueBy
    ? new Date(dueBy * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC"
    : "no deadline given";
  return (
    `Stripe dispute ${dispute.id} is ${dispute.status} for ${amount} ${currency}. ` +
    `Reason: ${dispute.reason || "unknown"}. Evidence due by ${deadline}. (${reason})`
  );
}

async function record(order, dispute) {
  const note = formatNote(dispute, "recorded by the disputes reconciler");
  await woo(`/orders/${order.id}/notes`, { method: "POST", body: JSON.stringify({ note }) });
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: DISPUTE_META_KEY, value: dispute.status }] }),
  });
  if (
    HOLD_ON_OPEN_DISPUTE &&
    OPEN_STATUSES.has(dispute.status) &&
    !["on-hold", "refunded", "cancelled"].includes(order.status)
  ) {
    await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status: "on-hold" }) });
  }
}

export async function run() {
  let recorded = 0;
  for await (const dispute of recentDisputes(LOOKBACK_HOURS)) {
    const intentId = await intentIdOfDispute(dispute);
    const order = await findOrderByIntent(intentId);
    const [action, reason] = decide(order, dispute);
    if (action === "orphan") {
      console.warn(`Dispute ${dispute.id} (intent ${intentId}): ${reason}`);
      continue;
    }
    if (action === "skip") continue;
    console.log(
      `Dispute ${dispute.id} on order ${order.id}: ${reason}. ${DRY_RUN ? "would record" : "recording"}`
    );
    if (!DRY_RUN) await record(order, dispute);
    recorded++;
  }
  console.log(`Done. ${recorded} dispute(s) ${DRY_RUN ? "to record" : "recorded"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
