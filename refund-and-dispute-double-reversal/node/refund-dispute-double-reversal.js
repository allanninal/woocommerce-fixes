/**
 * Find charges where a refund and a dispute both pulled money out.
 *
 * A charge can be refunded by the store and later disputed by the buyer's
 * bank. Those are two separate withdrawals in Stripe, so the same sale can be
 * paid for twice by the merchant: once through the refund, once through the
 * dispute plus its fee. This walks recent disputes, checks each charge's
 * refund history, and reports every case where money left the account twice,
 * adding an order note with the estimated extra loss. Read only by default.
 * Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/refund-and-dispute-double-reversal/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DEFAULT_DISPUTE_FEE_CENTS = Number(process.env.DEFAULT_DISPUTE_FEE_CENTS || 1500);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* recentDisputes(lookbackDays) {
  const since = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  for await (const dispute of stripe.disputes.list({ limit: 100, created: { gte: since } })) {
    yield dispute;
  }
}

async function getChargeWithRefunds(chargeId) {
  return stripe.charges.retrieve(chargeId, { expand: ["refunds"] });
}

/** Total minor units (cents) refunded on this charge before cutoffTs. */
export function refundedBefore(charge, cutoffTs) {
  let total = 0;
  for (const refund of (charge.refunds && charge.refunds.data) || []) {
    if (refund.status === "succeeded" && refund.created <= cutoffTs) total += refund.amount;
  }
  return total;
}

/**
 * Pure decision function. All amounts are in minor units (cents).
 * Returns [action, reason, lossCents].
 * - "skip": nothing was refunded before the dispute, this is a normal dispute.
 * - "double_reversal": the charge was already refunded, so the overlap
 *   between the refunded amount and the disputed amount, plus the dispute
 *   fee, is money that left the account twice.
 */
export function decide(disputeAmount, refundedBeforeAmount, disputeFee = DEFAULT_DISPUTE_FEE_CENTS) {
  if (refundedBeforeAmount <= 0) {
    return ["skip", "no refund existed before this dispute", 0];
  }
  const overlap = Math.min(disputeAmount, refundedBeforeAmount);
  const loss = overlap + disputeFee;
  return ["double_reversal", "charge was refunded before the dispute", loss];
}

async function findOrderByIntent(intentId) {
  if (!intentId) return null;
  const orders = await woo(`/orders?search=${encodeURIComponent(intentId)}&per_page=5`);
  for (const order of orders) {
    const hit = (order.meta_data || []).some(
      (m) => m.key === "_stripe_intent_id" && m.value === intentId
    );
    if (hit || order.transaction_id === intentId) return order;
  }
  return null;
}

async function recordLoss(orderId, disputeId, lossCents, currency) {
  const note =
    `Double reversal detected. Dispute ${disputeId} withdrew money on a charge ` +
    `that was already refunded. Estimated extra loss: ${(lossCents / 100).toFixed(2)} ${currency.toUpperCase()}. ` +
    `Review and submit evidence if the refund predates the dispute.`;
  await woo(`/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ note }) });
}

export async function run() {
  let flagged = 0;
  let totalLossCents = 0;
  for await (const dispute of recentDisputes(LOOKBACK_DAYS)) {
    const chargeId = dispute.charge;
    const charge = await getChargeWithRefunds(chargeId);
    const refunded = refundedBefore(charge, dispute.created);
    const [action, reason, loss] = decide(dispute.amount, refunded);
    if (action === "skip") continue;
    const intentId = charge.payment_intent;
    const order = await findOrderByIntent(intentId);
    const orderId = order ? order.id : null;
    console.warn(
      `Charge ${chargeId}: ${reason}. Extra loss ${(loss / 100).toFixed(2)} ${dispute.currency.toUpperCase()}. ` +
      `${DRY_RUN ? "would record" : "recording"}`
    );
    if (!DRY_RUN && orderId) await recordLoss(orderId, dispute.id, loss, dispute.currency);
    flagged++;
    totalLossCents += loss;
  }
  console.log(`Done. ${flagged} double reversal(s) found, total extra loss ${(totalLossCents / 100).toFixed(2)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
