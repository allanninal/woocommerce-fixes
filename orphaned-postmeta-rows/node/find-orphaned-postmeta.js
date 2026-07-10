/**
 * Find WooCommerce postmeta rows that point at an order which no longer exists.
 *
 * Every order keeps its Stripe link in postmeta, in the key `_stripe_intent_id`, or
 * in the `transaction_id` column when the plugin writes it there instead. When an
 * order is deleted straight from wp_posts (a manual cleanup script, a bad SQL DELETE,
 * a plugin that skips wp_delete_post's meta cleanup) the postmeta row can survive
 * with nothing left to attach to. That row is now orphaned: it takes up space, it
 * can resurface in stale reports, and on some pages it drags in a Stripe API call
 * for an order the shop can never show you.
 *
 * This script does not scan the database directly. It walks Stripe PaymentIntents,
 * since Stripe is the durable record of "an order used to exist here", and checks
 * the WooCommerce REST API to see whether the order it points to is still there.
 * Anything missing is an orphan candidate. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/orphaned-postmeta-rows/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 90);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision: no I/O, only plain data in, one action out.
 *
 * order is null when the WooCommerce REST API has nothing at that id, which is
 * exactly what happens when the post row was deleted but a Stripe PaymentIntent
 * still carries metadata.order_id pointing at it. That is the orphan we report.
 */
export function decide(order, intent) {
  if (!intent) return ["skip", "no Stripe intent to check"];
  const orderId = intent.metadata && intent.metadata.order_id;
  if (!orderId) return ["skip", "intent has no order_id in metadata"];
  if (!order) return ["orphan", `order ${orderId} is gone but Stripe still references it`];
  if (String(order.id) !== String(orderId)) return ["skip", "order id mismatch, not our concern here"];
  return ["ok", "order still exists"];
}

async function woo(path) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    headers: { "Content-Type": "application/json", Authorization: AUTH },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* recentIntents(lookbackDays) {
  const since = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    if (intent.metadata && intent.metadata.order_id) yield intent;
  }
}

/**
 * Read only: write a line to the log. This never deletes anything on its own.
 *
 * Cleaning the leftover postmeta rows is a database job (DELETE FROM wp_postmeta
 * WHERE post_id NOT IN (SELECT ID FROM wp_posts)), which is outside what a REST
 * API script should attempt. This function's job is to hand the shop a precise,
 * reviewed list so that cleanup step is safe to run.
 */
function reportOrphan(orderId, intent, reason) {
  console.warn(`Orphan candidate: order ${orderId}, PaymentIntent ${intent.id}. ${reason}`);
}

export async function run() {
  let orphans = 0;
  for await (const intent of recentIntents(LOOKBACK_DAYS)) {
    const orderId = intent.metadata.order_id;
    const order = await woo(`/orders/${orderId}`);
    const [action, reason] = decide(order, intent);
    if (action !== "orphan") continue;
    console.log(`Order ${orderId}: ${reason}. ${DRY_RUN ? "would report" : "reporting"}`);
    reportOrphan(orderId, intent, reason);
    orphans++;
  }
  console.log(`Done. ${orphans} orphan candidate(s) found.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
