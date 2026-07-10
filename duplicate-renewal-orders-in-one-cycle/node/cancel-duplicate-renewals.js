/**
 * Find duplicate renewal orders made for the same subscription in one billing
 * cycle, and cancel the extra one.
 *
 * WooCommerce Subscriptions can create two renewal orders for a single period
 * when the scheduled renewal action fires twice, for example after Action
 * Scheduler retries a slow run, or a shop manager clicks "Process renewal"
 * while the cron copy is still mid flight. Both orders carry the same
 * subscription id in their _subscription_renewal meta and the same
 * _subscription_renewal_date. This walks recent renewal orders, groups them by
 * (subscription id, renewal date), and for every group bigger than one, keeps
 * exactly one order and cancels the rest, but only when the extra order was
 * never actually paid. A renewal that Stripe really charged is never touched
 * here, that is a different problem (a real double charge) with its own
 * guide. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/duplicate-renewal-orders-in-one-cycle/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 3);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);
const UNPAID_STATUSES = new Set(["pending", "on-hold", "failed"]);

export function metaValue(order, key) {
  for (const meta of order.meta_data || []) {
    if (meta.key === key) return meta.value;
  }
  return undefined;
}

export function intentIdOf(order) {
  const value = metaValue(order, "_stripe_intent_id");
  if (value) return value;
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

export function renewalKey(order) {
  const subId = metaValue(order, "_subscription_renewal");
  const renewalDate = metaValue(order, "_subscription_renewal_date");
  if (!subId || !renewalDate) return null;
  return `${subId}::${renewalDate}`;
}

export function groupRenewals(orders) {
  const groups = new Map();
  for (const order of orders) {
    const key = renewalKey(order);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }
  return groups;
}

export function chooseKeeper(group) {
  const paid = group.filter((o) => PAID_STATUSES.has(o.status));
  const pool = paid.length ? paid : group;
  return pool.reduce((min, o) => (o.id < min.id ? o : min), pool[0]);
}

/**
 * Pure decision function: given one group of orders that share a subscription
 * id and renewal date, return a list of { order, action, reason }.
 *
 * intentsByOrderId is an optional map of order id to a Stripe PaymentIntent
 * object (or null), used to double check an order marked paid really was
 * charged before it is ever left alone as a "keeper" on that basis alone
 * versus flagged as a mismatch. Defaults to an empty map, in which case the
 * decision relies only on the WooCommerce order status.
 */
export function decide(group, intentsByOrderId = new Map()) {
  if (group.length < 2) {
    return group.length === 1
      ? [{ order: group[0], action: "skip", reason: "only one renewal order for this cycle" }]
      : [];
  }

  const keeper = chooseKeeper(group);
  const results = [];
  for (const order of group) {
    if (order.id === keeper.id) {
      results.push({ order, action: "keep", reason: "kept as the order for this billing cycle" });
      continue;
    }
    if (PAID_STATUSES.has(order.status)) {
      const intent = intentsByOrderId.get(order.id);
      if (intent && intent.status === "succeeded") {
        // Two orders in the same cycle both look genuinely charged. That is
        // a real double charge, not a duplicate order to cancel
        // automatically. Flag it for a human instead.
        results.push({ order, action: "flag", reason: "both orders appear paid, needs manual review" });
        continue;
      }
      results.push({ order, action: "flag", reason: "marked paid but not confirmed by Stripe, needs manual review" });
      continue;
    }
    if (!UNPAID_STATUSES.has(order.status)) {
      results.push({ order, action: "skip", reason: `status ${order.status} is not safe to cancel automatically` });
      continue;
    }
    results.push({ order, action: "cancel", reason: "duplicate renewal order, never paid" });
  }
  return results;
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

async function* recentRenewalOrders(lookbackDays) {
  const after = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=100&page=${page}&orderby=id&order=asc`);
    if (!batch.length) return;
    for (const order of batch) {
      if (metaValue(order, "_subscription_renewal")) yield order;
    }
    page++;
  }
}

async function cancelOrder(order, reason) {
  await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Cancelled by the duplicate renewal cleanup: ${reason}. ` +
            `This subscription already has another renewal order for the same cycle.`,
    }),
  });
}

export async function run() {
  const orders = [];
  for await (const order of recentRenewalOrders(LOOKBACK_DAYS)) orders.push(order);
  const groups = groupRenewals(orders);

  let cancelled = 0;
  let flagged = 0;
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const [subId, renewalDate] = key.split("::");

    const intentsByOrderId = new Map();
    for (const order of group) {
      if (PAID_STATUSES.has(order.status)) {
        intentsByOrderId.set(order.id, await getIntent(intentIdOf(order)));
      }
    }

    for (const { order, action, reason } of decide(group, intentsByOrderId)) {
      if (action === "keep" || action === "skip") continue;
      if (action === "flag") {
        console.warn(`Subscription ${subId}, order ${order.id}: ${reason}`);
        flagged++;
        continue;
      }
      console.log(
        `Subscription ${subId}, renewal ${renewalDate}, order ${order.id}: ${reason}. ` +
        `${DRY_RUN ? "would cancel" : "cancelling"}`
      );
      if (!DRY_RUN) await cancelOrder(order, reason);
      cancelled++;
    }
  }
  console.log(`Done. ${cancelled} order(s) ${DRY_RUN ? "to cancel" : "cancelled"}, ${flagged} flagged for manual review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
