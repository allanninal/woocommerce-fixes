/**
 * Exclude trashed WooCommerce orders that are still counted in Analytics.
 *
 * WooCommerce Analytics reads its totals from a lookup table (wc_order_stats), not
 * straight from the order list. An order is only pulled out of that table when the
 * normal "move to Trash" action fires and WooCommerce sets its own `_exclude_from_stats`
 * meta. A direct database delete, a cleanup cron, or a plugin that trashes orders by
 * writing the status column directly can skip that step, so a trashed order keeps
 * contributing to revenue and order count totals. This walks orders with status
 * `trash`, cross-checks the Stripe PaymentIntent as a safety net so a good order is
 * never silently hidden, and repairs the ones that should be excluded by setting
 * `_exclude_from_stats` to `yes`. Safe by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/trashed-orders-still-counted-in-stats/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EXCLUDE_META_KEY = "_exclude_from_stats";

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function isExcluded(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === EXCLUDE_META_KEY) {
      return ["yes", "1", "true"].includes(String(meta.value));
    }
  }
  return false;
}

/**
 * Pure decision function. No I/O. Returns [action, reason].
 *
 * action is one of: "skip", "repair", "hold".
 * - skip: nothing to do, order is not trashed or is already excluded.
 * - repair: trashed and not excluded, and Stripe agrees there is nothing live
 *   to protect (no succeeded charge, or the charge was refunded), so it is
 *   safe to mark it excluded from stats.
 * - hold: trashed and not excluded, but Stripe still shows a succeeded,
 *   unrefunded charge. Do not silently hide real revenue. Flag for a human.
 */
export function decide(order, intent) {
  if (order.status !== "trash") return ["skip", "order is not in trash"];
  if (isExcluded(order)) return ["skip", "already excluded from stats"];
  if (!intent) return ["repair", "trashed with no Stripe charge on record"];
  if (intent.status !== "succeeded") return ["repair", "trashed and Stripe charge did not succeed"];
  const received = intent.amount_received || 0;
  const refunded = intent.amount_refunded || 0;
  if (received > 0 && refunded >= received) {
    return ["repair", "trashed and the Stripe charge was fully refunded"];
  }
  return ["hold", "trashed but Stripe still shows a live, unrefunded charge"];
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

async function* trashedOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=trash&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function excludeFromStats(order) {
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: EXCLUDE_META_KEY, value: "yes" }] }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Excluded from Analytics: order is trashed and Stripe confirms there is " +
            "no live, unrefunded charge behind it. Set by the " +
            "trashed-orders-still-counted-in-stats script.",
    }),
  });
}

async function flagForReview(order, reason) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Stats check held: ${reason}. This order is trashed but Stripe still shows ` +
            `a real, unrefunded charge. Not excluding it automatically. Please review ` +
            `before it is deleted for good.`,
    }),
  });
}

export async function run() {
  let repaired = 0;
  let held = 0;
  for await (const order of trashedOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action === "skip") continue;
    if (action === "hold") {
      console.warn(`Order ${order.id} held: ${reason}`);
      if (!DRY_RUN) await flagForReview(order, reason);
      held++;
      continue;
    }
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would exclude" : "excluding"}`);
    if (!DRY_RUN) await excludeFromStats(order);
    repaired++;
  }
  console.log(`Done. ${repaired} order(s) ${DRY_RUN ? "to exclude" : "excluded"}, ${held} held for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
