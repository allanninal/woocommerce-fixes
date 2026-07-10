/**
 * Detect a WooCommerce store where WP-Cron is disabled or starved, so order
 * emails and the Action Scheduler queue never fire. Read only by default.
 *
 * This walks recent orders, checks each one's notes for evidence its
 * confirmation email went out, and raises a store-level alarm once enough
 * orders have waited past a safe threshold with no such note. It never
 * changes an order's status or total. When it does raise the alarm and
 * DRY_RUN is off, it leaves one diagnostic note on the oldest stuck order.
 *
 * Run this from a real system cron, not from anything that depends on the
 * WordPress site's own WP-Cron, since that is the thing being checked.
 *
 * Guide: https://www.allanninal.dev/woocommerce/wp-cron-disabled-emails-never-send/
 */
import { pathToFileURL } from "node:url";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 6);
const STUCK_MINUTES = Number(process.env.STUCK_MINUTES || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EMAIL_NOTE_MARKERS = ["email sent", "order status changed", "note sent to customer"];
const MIN_STUCK_TO_ALARM = 3;

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

/** Orders created in the lookback window, oldest first. */
async function recentOrders(lookbackHours) {
  const since = new Date(Date.now() - lookbackHours * 3600000).toISOString();
  return woo(`/orders?after=${since}&per_page=100&orderby=date&order=asc`);
}

async function orderNotes(orderId) {
  return woo(`/orders/${orderId}/notes`);
}

/**
 * The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id.
 *
 * Used only to cross-check a flagged order by hand: confirming the payment
 * succeeded on Stripe rules out the payment side and points back at the
 * email/scheduling side as the actual fault.
 */
export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/** True when an order note looks like the confirmation email went out. */
export function hasEmailNote(notes) {
  return notes.some((note) => {
    const text = (note.note || "").toLowerCase();
    return note.customer_note || EMAIL_NOTE_MARKERS.some((m) => text.includes(m));
  });
}

/** Minutes between the order's creation time and now (both UTC). */
export function minutesWaiting(order, now) {
  const raw = order.date_created_gmt;
  const created = new Date(raw.endsWith("Z") ? raw : raw + "Z");
  return (now.getTime() - created.getTime()) / 60000;
}

/**
 * Pure decision: does this one order look stuck on its confirmation email?
 *
 * Returns a [action, reason] tuple. action is one of:
 *   "ok"    - a confirmation note already exists, nothing to worry about
 *   "wait"  - too soon to judge, still inside the grace window
 *   "stuck" - past the threshold with no confirming note
 */
export function decide(order, notes, now, stuckMinutes) {
  const waited = minutesWaiting(order, now);
  if (hasEmailNote(notes)) return ["ok", "a confirmation note already exists"];
  if (waited < stuckMinutes) return ["wait", "too soon to judge, still inside the grace window"];
  return ["stuck", `no confirmation note after ${Math.floor(waited)} minutes`];
}

/**
 * Pure decision: does the whole batch look like a WP-Cron outage?
 *
 * A single stuck order can be a fluke. A backlog is a signal.
 */
export function storeVerdict(stuckCount) {
  if (stuckCount >= MIN_STUCK_TO_ALARM) {
    return ["alarm", `${stuckCount} orders stuck, WP-Cron is likely disabled or starved`];
  }
  if (stuckCount > 0) {
    return ["watch", `${stuckCount} order(s) stuck, below the alarm threshold`];
  }
  return ["healthy", "no stuck orders in this window"];
}

async function leaveDiagnosticNote(orderId, reason) {
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `WP-Cron watchdog: ${reason}. WP-Cron appears disabled or starved on this store. ` +
            `Check DISABLE_WP_CRON in wp-config.php and whether a real system cron calls wp-cron.php.`,
    }),
  });
}

export async function run() {
  const now = new Date();
  const stuckOrders = [];
  for (const order of await recentOrders(LOOKBACK_HOURS)) {
    const notes = await orderNotes(order.id);
    const [action, reason] = decide(order, notes, now, STUCK_MINUTES);
    if (action === "stuck") {
      console.warn(`Order ${order.id}: ${reason}`);
      stuckOrders.push([order, reason]);
    }
  }
  const [verdict, message] = storeVerdict(stuckOrders.length);
  console.log(`Verdict: ${verdict}. ${message}`);
  if (verdict === "alarm" && stuckOrders.length && !DRY_RUN) {
    const [oldestOrder, reason] = stuckOrders[0];
    await leaveDiagnosticNote(oldestOrder.id, reason);
  }
  console.log(`Done. ${DRY_RUN && verdict === "alarm" ? "would flag" : "checked"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
