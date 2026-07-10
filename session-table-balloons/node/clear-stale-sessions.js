/**
 * Clear a bloated wp_woocommerce_sessions table, without cutting off a live checkout.
 *
 * WooCommerce is supposed to prune expired session rows on its own, every time a
 * scheduled cleanup event runs. When that event stops firing (WP-Cron disabled, Action
 * Scheduler stuck, a host that kills long requests), expired rows never get removed and
 * the table grows without bound. Some stores have reported this table alone reaching
 * several gigabytes, almost all of it expired rows.
 *
 * WooCommerce ships a REST-reachable maintenance tool that empties the sessions table:
 * PUT /wp-json/wc/v3/system_status/tools/clear_sessions. It is effective but blunt, it
 * wipes every session, including a shopper who is mid-checkout right now. So before we
 * run it we check Stripe for any PaymentIntent created in the last few minutes that is
 * still open (requires_action, processing, or requires_payment_method), using the
 * PaymentIntent id saved on the matching WooCommerce order's _stripe_intent_id meta (or
 * transaction_id as a fallback). If anyone looks like they are actively paying, we wait.
 *
 * Safe by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/session-table-balloons/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const MAX_SESSIONS_MB = Number(process.env.MAX_SESSIONS_MB || 50);
const CHECKOUT_GUARD_MINUTES = Number(process.env.CHECKOUT_GUARD_MINUTES || 15);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const OPEN_INTENT_STATUSES = new Set([
  "requires_action", "requires_confirmation", "processing", "requires_payment_method",
]);
const LIVE_ORDER_STATUSES = ["pending", "on-hold", "checkout-draft"];

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function sessionsTableSizeMb(systemStatus) {
  const tables = systemStatus?.database?.database_tables?.other || {};
  const row = tables.woocommerce_sessions || tables.wp_woocommerce_sessions || {};
  return Number(row.data || 0) + Number(row.index || 0);
}

/**
 * Pure decision: should we clear the sessions table right now?
 *
 * sessionsSizeMb    -- current size (data + index, MB) of wp_woocommerce_sessions
 * thresholdMb       -- size at which the table counts as bloated
 * openCheckoutCount -- number of recent orders with a Stripe PaymentIntent that is
 *                      still open (a shopper who may be mid-checkout right now)
 */
export function decide(sessionsSizeMb, thresholdMb, openCheckoutCount) {
  if (sessionsSizeMb < thresholdMb) return ["skip", "sessions table is under the size threshold"];
  if (openCheckoutCount > 0) return ["wait", "a checkout looks in progress, wait for it to settle"];
  return ["clear", "sessions table is bloated and no checkout is in progress"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getSystemStatus() {
  return woo("/system_status");
}

async function recentLiveOrders(guardMinutes) {
  const after = new Date(Date.now() - guardMinutes * 60000).toISOString();
  return woo(`/orders?status=${LIVE_ORDER_STATUSES.join(",")}&after=${after}&per_page=50`);
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function countOpenCheckouts(guardMinutes) {
  const orders = await recentLiveOrders(guardMinutes);
  let openCount = 0;
  for (const order of orders) {
    const intent = await getIntent(intentIdOf(order));
    if (intent && OPEN_INTENT_STATUSES.has(intent.status)) openCount++;
  }
  return openCount;
}

async function clearSessions() {
  await woo("/system_status/tools/clear_sessions", { method: "PUT" });
}

export async function run() {
  const status = await getSystemStatus();
  const sizeMb = sessionsTableSizeMb(status);
  const openCheckouts = await countOpenCheckouts(CHECKOUT_GUARD_MINUTES);
  const [action, reason] = decide(sizeMb, MAX_SESSIONS_MB, openCheckouts);

  if (action === "skip") {
    console.log(`Sessions table is ${sizeMb.toFixed(1)} MB, under the ${MAX_SESSIONS_MB} MB threshold. Nothing to do.`);
    return;
  }
  if (action === "wait") {
    console.warn(
      `Sessions table is ${sizeMb.toFixed(1)} MB (over ${MAX_SESSIONS_MB} MB) but ${openCheckouts} ` +
      `checkout(s) look in progress. ${reason}`
    );
    return;
  }

  console.log(
    `Sessions table is ${sizeMb.toFixed(1)} MB (over ${MAX_SESSIONS_MB} MB) and no checkout is in progress. ` +
    (DRY_RUN ? "Would clear it." : "Clearing it now.")
  );
  if (!DRY_RUN) {
    await clearSessions();
    console.log("Cleared wp_woocommerce_sessions.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
