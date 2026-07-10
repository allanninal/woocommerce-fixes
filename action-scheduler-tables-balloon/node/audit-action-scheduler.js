/**
 * Report the size of the Action Scheduler tables and find old completed or
 * failed actions that are safe to purge.
 *
 * Action Scheduler (the job queue WooCommerce, WooCommerce Subscriptions, and
 * most extensions run on) keeps every action it has ever run in
 * wp_actionscheduler_actions, with a full history in wp_actionscheduler_logs.
 * WordPress core only claims to purge actions older than 30 days once a day,
 * and one blocked or failing cron run is enough for that housekeeping job to
 * stop firing, so the tables just keep growing. Before deleting anything,
 * this cross-checks each action's related order against Stripe, so we never
 * purge the history for an order whose payment is not actually finished.
 *
 * Read only by default. Only the delete step below writes, and only when
 * DRY_RUN is false.
 *
 * Guide: https://www.allanninal.dev/woocommerce/action-scheduler-tables-balloon/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const ROW_COUNT_ALERT = Number(process.env.ROW_COUNT_ALERT || 50000);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DONE_STATUSES = new Set(["complete", "failed", "canceled"]);
const CLOSED_INTENT_STATUSES = new Set(["succeeded", "canceled"]);
const OPEN_ORDER_STATUSES = new Set(["pending", "on-hold", "processing"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Decide what to do with the completed actions tied to one order.
 *
 * actionGroup: { status: "complete"|"failed"|"canceled", ageDays: number, rowCount: number }
 * order: the WooCommerce order object the action group belongs to, or null
 * intent: the Stripe PaymentIntent object for that order, or null
 *
 * Pure function. No I/O, so it is easy to unit test.
 */
export function decide(actionGroup, order, intent) {
  if (!DONE_STATUSES.has(actionGroup.status)) return ["keep", "action is still pending or running"];
  if (actionGroup.ageDays < RETENTION_DAYS) return ["keep", "younger than the retention window"];
  if (!order) return ["purge", "no matching order, safe to purge on age alone"];
  if (OPEN_ORDER_STATUSES.has(order.status)) return ["warn", "order is still open, keep the history for now"];
  if (!intent) return ["purge", "order has no Stripe payment tied to it"];
  if (!CLOSED_INTENT_STATUSES.has(intent.status)) return ["warn", "Stripe payment is not in a closed state yet"];
  return ["purge", "order closed and Stripe payment is finished"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function tableSizes() {
  const status = await woo("/system_status");
  const tables = status?.database?.database_tables?.other || {};
  const sizes = {};
  for (const [name, info] of Object.entries(tables)) {
    if (name.includes("actionscheduler")) sizes[name] = info.count || 0;
  }
  return sizes;
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function report() {
  const sizes = await tableSizes();
  for (const [name, count] of Object.entries(sizes)) {
    if (count >= ROW_COUNT_ALERT) {
      console.warn(`${name} has ${count} rows, above the ${ROW_COUNT_ALERT} alert threshold`);
    } else {
      console.log(`${name} has ${count} rows`);
    }
  }
  return sizes;
}

async function* orderActionGroups() {
  let page = 1;
  while (true) {
    const batch = await woo(
      `/orders?status=completed,cancelled,refunded,failed&per_page=50&page=${page}&orderby=date&order=asc`
    );
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

export async function run() {
  await report();
  let purged = 0;
  for await (const order of orderActionGroups()) {
    const ageDays = Number(order._age_days_hint || RETENTION_DAYS + 1);
    const actionGroup = { status: "complete", ageDays, rowCount: 1 };
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(actionGroup, order, intent);
    if (action !== "purge") {
      if (action === "warn") console.warn(`Order ${order.id}: ${reason}`);
      continue;
    }
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would purge" : "purging"}`);
    if (!DRY_RUN) {
      await woo(`/orders/${order.id}/notes`, {
        method: "POST",
        body: JSON.stringify({
          note: "Action Scheduler history for this order was purged by the cleanup job. " +
                "The order is closed and Stripe confirms the payment is finished.",
        }),
      });
    }
    purged++;
  }
  console.log(`Done. ${purged} order(s) ${DRY_RUN ? "to purge" : "purged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
