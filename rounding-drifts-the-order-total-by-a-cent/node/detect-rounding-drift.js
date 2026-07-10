/**
 * Detect WooCommerce orders whose total is off by a cent (or two) from what
 * Stripe actually charged.
 *
 * WooCommerce can round each line item's tax separately while Stripe (or the
 * card network) rounds the grand total once, so the two systems land on
 * different final digits even though nothing is actually wrong with the sale.
 * This walks recent paid orders, reads the saved Stripe PaymentIntent,
 * compares the amounts in minor units (cents), and flags any order where the
 * drift is larger than the tolerance (a real mismatch) or, optionally, notes
 * the ones off by exactly one or two cents so accounting can reconcile them.
 * Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/rounding-drifts-the-order-total-by-a-cent/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
// A drift of 1 cent is the classic rounding case. Anything larger is a real
// mismatch worth a louder flag (wrong currency conversion, a fee that was
// not saved, a manually edited order, and so on).
const ROUNDING_TOLERANCE_CENTS = Number(process.env.ROUNDING_TOLERANCE_CENTS || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderTotalMinor(order) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and
  // friends) have their own guide, since 50.00 is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision: no network, no I/O. Given a WooCommerce order (object) and
 * its Stripe PaymentIntent (object or null), return an [action, reason] pair.
 *
 * Actions:
 *   skip     - order is not in a paid state, nothing to check yet.
 *   orphan   - order is paid but has no PaymentIntent id or Stripe cannot
 *              find it, worth a look but not a rounding problem.
 *   drift    - the amounts differ by more than zero cents but no more than
 *              ROUNDING_TOLERANCE_CENTS, the classic rounding case.
 *   mismatch - the amounts differ by more than the tolerance, a real
 *              problem that is not just rounding.
 *   ok       - the amounts match exactly.
 */
export function decide(order, intent, toleranceCents = ROUNDING_TOLERANCE_CENTS) {
  if (!PAID_STATUSES.has(order.status)) return ["skip", "order not in a paid state"];
  if (!intent) return ["orphan", "no Stripe PaymentIntent found for a paid order"];
  if (intent.status !== "succeeded") return ["orphan", "Stripe shows the payment not succeeded"];

  const charged = intent.amount_received;
  if (charged === undefined || charged === null) {
    return ["orphan", "PaymentIntent has no amount_received"];
  }

  const diffCents = orderTotalMinor(order) - charged;
  if (diffCents === 0) return ["ok", "order total matches the Stripe charge exactly"];
  if (Math.abs(diffCents) <= toleranceCents) {
    return ["drift", `order total is ${diffCents > 0 ? "+" : ""}${diffCents} cent(s) from the Stripe charge`];
  }
  return ["mismatch", `order total is ${diffCents > 0 ? "+" : ""}${diffCents} cent(s) from the Stripe charge, too large to be rounding`];
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

async function report(order, action, reason) {
  const note =
    `Rounding check: ${reason}. Order total is ${order.total} ${order.currency || ""}. ` +
    `Flagged as ${action} by the rounding drift detector.`;
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export async function run() {
  let flagged = 0;
  for await (const order of paidOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action === "skip" || action === "ok") continue;
    console.warn(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) await report(order, action, reason);
    flagged++;
  }
  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
