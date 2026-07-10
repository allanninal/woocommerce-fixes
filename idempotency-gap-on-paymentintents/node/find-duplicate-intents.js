/**
 * Find WooCommerce orders that were charged twice because a retry went out
 * without a Stripe Idempotency-Key.
 *
 * A flaky network, a page refresh, or a double-click on "Place order" can
 * send the same checkout request twice. When neither request carries the
 * same Idempotency-Key, Stripe treats them as two different payments and can
 * create two separate PaymentIntents, both of which succeed. WooCommerce
 * only stores one PaymentIntent id on the order, so the extra charge is
 * invisible unless you go looking for it in Stripe.
 *
 * This script reads the PaymentIntent id saved on each recent paid order
 * (meta _stripe_intent_id, falling back to transaction_id), looks up that
 * intent's Stripe Customer, and lists every other succeeded PaymentIntent
 * created for that same customer within a short window with the same
 * amount. Anything it finds beyond the one saved on the order is a likely
 * duplicate charge.
 *
 * Read only by default. Refunding is a separate, explicit step you take
 * after reviewing the report, never automatic.
 *
 * Guide: https://www.allanninal.dev/woocommerce/idempotency-gap-on-paymentintents/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const MATCH_WINDOW_MINUTES = Number(process.env.MATCH_WINDOW_MINUTES || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since 50.00 is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision function. No I/O.
 *
 * primaryIntent: the PaymentIntent whose id is saved on the order.
 * otherIntents: every other succeeded PaymentIntent for the same customer,
 *   as plain objects with at least id, status, amount_received, created.
 * orderAmountMinorValue: the order total in minor units (cents).
 * windowSeconds: how close in time a second charge has to be to count.
 *
 * Returns an array of [intent, reason] pairs, one per likely duplicate. An
 * intent only counts as a duplicate when it succeeded, is not the primary
 * intent, matches the order amount, and was created within the time window
 * of the primary intent.
 */
export function findCandidateDuplicates(primaryIntent, otherIntents, orderAmountMinorValue, windowSeconds) {
  const duplicates = [];
  if (!primaryIntent || primaryIntent.status !== "succeeded") return duplicates;
  const primaryCreated = primaryIntent.created || 0;
  for (const candidate of otherIntents) {
    if (candidate.id === primaryIntent.id) continue;
    if (candidate.status !== "succeeded") continue;
    if (Math.abs((candidate.amount_received || 0) - orderAmountMinorValue) > 1) continue;
    if (Math.abs((candidate.created || 0) - primaryCreated) > windowSeconds) continue;
    duplicates.push([candidate, "same customer, same amount, created within the match window"]);
  }
  return duplicates;
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

async function otherSucceededForCustomer(customerId, excludeIntentId, lookbackDays) {
  if (!customerId) return [];
  const since = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  const results = [];
  for await (const intent of stripe.paymentIntents.list({ customer: customerId, limit: 100, created: { gte: since } })) {
    if (intent.id === excludeIntentId) continue;
    if (intent.status === "succeeded") results.push(intent);
  }
  return results;
}

async function* paidOrders(lookbackDays) {
  const after = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function flag(order, duplicateIntentIds) {
  const note =
    "Possible duplicate charge detected. This order's saved PaymentIntent " +
    "succeeded, but Stripe also shows " + duplicateIntentIds.join(", ") +
    " as succeeded for the same customer, amount, and time window. " +
    "This can happen when a retry goes out without an Idempotency-Key. " +
    "Please review in Stripe before refunding.";
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export async function run() {
  let flagged = 0;
  for await (const order of paidOrders(LOOKBACK_DAYS)) {
    if (!PAID_STATUSES.has(order.status)) continue;
    const primary = await getIntent(intentIdOf(order));
    if (!primary) continue;
    const others = await otherSucceededForCustomer(primary.customer, primary.id, LOOKBACK_DAYS);
    const duplicates = findCandidateDuplicates(primary, others, orderAmountMinor(order), MATCH_WINDOW_MINUTES * 60);
    if (!duplicates.length) continue;
    const duplicateIds = duplicates.map(([intent]) => intent.id);
    console.warn(
      `Order ${order.id}: ${duplicateIds.length} likely duplicate charge(s) found: ${duplicateIds.join(", ")}. ` +
      `${DRY_RUN ? "would flag" : "flagging"}`
    );
    if (!DRY_RUN) await flag(order, duplicateIds);
    flagged++;
  }
  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
