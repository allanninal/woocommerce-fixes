/**
 * Purge stale WooCommerce reconciliation meta left behind on long settled orders.
 *
 * Action Scheduler's own daily cleanup should remove old completed and canceled
 * actions, but it depends on WP-Cron firing reliably and a batch size that can
 * keep up with the store's volume. When it falls behind, both the
 * actionscheduler_actions table and ad hoc reconciliation meta written onto
 * orders by past webhook-repair and payment-verification scripts pile up
 * forever. This walks settled orders past a retention window, re-confirms the
 * linked Stripe PaymentIntent, and only purges the stale meta once Stripe
 * still agrees the order is genuinely paid and settled. Read only by default
 * (dry run). Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/completed-actions-never-purged/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);
const PURGEABLE_KEYS = new Set(["_reconciler_checked_at", "_webhook_repair_log", "_payment_verify_pass"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function purgeableMetaIds(order) {
  return (order.meta_data || []).filter((m) => PURGEABLE_KEYS.has(m.key)).map((m) => m.id);
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision: what to do with an order's stale reconciliation meta.
 * No I/O. Takes plain objects so it is easy to unit test.
 */
export function decide(order, intent, retentionDays, now = new Date()) {
  if (!PAID_STATUSES.has(order.status)) return ["skip", "order not in a settled state"];
  const metaIds = purgeableMetaIds(order);
  if (!metaIds.length) return ["skip", "nothing to purge"];
  const modified = new Date(order.date_modified_gmt.endsWith("Z") ? order.date_modified_gmt : order.date_modified_gmt + "Z");
  if (now - modified < retentionDays * 86400000) return ["skip", "inside the retention window"];
  if (!intent || intent.status !== "succeeded") return ["keep", "Stripe no longer confirms a succeeded payment"];
  if (Math.abs(orderAmountMinor(order) - (intent.amount_received || 0)) > 1) {
    return ["keep", "amount no longer matches the Stripe charge"];
  }
  return ["purge", "settled, past retention, Stripe still confirms the payment"];
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

async function* settledOrders(retentionDays) {
  const before = new Date(Date.now() - retentionDays * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=${[...PAID_STATUSES].join(",")}&before=${before}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function purgeMeta(orderId, metaIds) {
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: metaIds.map((id) => ({ id, value: null })) }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Purged ${metaIds.length} stale reconciliation meta row(s) past the retention ` +
            `window. Stripe still confirms the payment, so the order itself is unchanged.`,
    }),
  });
}

export async function run() {
  let purged = 0;
  let kept = 0;
  for await (const order of settledOrders(RETENTION_DAYS)) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent, RETENTION_DAYS);
    if (action === "skip") continue;
    if (action === "keep") {
      console.warn(`Order ${order.id}: ${reason}. Leaving meta in place.`);
      kept++;
      continue;
    }
    const metaIds = purgeableMetaIds(order);
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would purge" : "purging"}`);
    if (!DRY_RUN) await purgeMeta(order.id, metaIds);
    purged++;
  }
  console.log(`Done. ${purged} order(s) ${DRY_RUN ? "to purge" : "purged"}, ${kept} kept for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
