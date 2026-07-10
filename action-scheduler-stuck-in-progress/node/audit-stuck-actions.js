/**
 * Find Action Scheduler actions stuck on in-progress and decide how to clear them.
 *
 * An action normally moves from pending, to in-progress, to complete within seconds.
 * When the PHP worker that claimed an action dies mid run (a timeout, an out of
 * memory kill, a fatal error), the action is left on in-progress forever. Action
 * Scheduler's own claim lock then treats that slot as busy, so the next run of that
 * group or hook can stall behind it, and the queue backs up.
 *
 * This script does not touch wp_actionscheduler_actions directly. It uses the
 * WooCommerce REST API to read the order that a stuck subscription renewal or
 * payment action points to (order id comes from a small JSON export of stuck
 * actions), asks Stripe for the truth about the PaymentIntent on that order, and
 * decides one of four outcomes: complete_order, reset_action, wait, or investigate.
 *
 * Read only by default (DRY_RUN=true). Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/action-scheduler-stuck-in-progress/
 */
import Stripe from "stripe";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const STUCK_AFTER_MINUTES = Number(process.env.STUCK_AFTER_MINUTES || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);
const IN_FLIGHT_INTENT_STATUSES = new Set(["requires_action", "requires_confirmation", "processing"]);
const FAILED_INTENT_STATUSES = new Set(["requires_payment_method", "canceled"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision function. No I/O. action is an object with at least status and
 * ageMinutes. order and intent may be null. Returns [verdict, reason].
 */
export function decide(action, order, intent) {
  if (action.status !== "in-progress") return ["skip", "action is not in-progress"];
  if ((action.ageMinutes || 0) < STUCK_AFTER_MINUTES) return ["wait", "action has not been stuck long enough yet"];
  if (!order) return ["investigate", "action points to an order that cannot be found"];
  if (intent && IN_FLIGHT_INTENT_STATUSES.has(intent.status)) {
    return ["investigate", "Stripe shows the payment still in flight"];
  }
  if (PAID_STATUSES.has(order.status)) return ["reset_action", "order is already paid, the action is just stale"];
  if (intent && intent.status === "succeeded") return ["complete_order", "Stripe succeeded but the order was never updated"];
  if (!intent || FAILED_INTENT_STATUSES.has(intent.status)) {
    return ["reset_action", "no successful charge behind this attempt, safe to retry"];
  }
  return ["investigate", "unclear Stripe state, needs a human look"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
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

async function completeOrder(orderId, intent) {
  const chargeId = intent.latest_charge || intent.id;
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "processing", transaction_id: chargeId }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Recovered from a stuck Action Scheduler action. Stripe PaymentIntent ` +
            `${intent.id} had already succeeded. Marked processing by the auditor.`,
    }),
  });
}

async function noteStuckAction(orderId, reason) {
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Action Scheduler action for this order was stuck on in-progress: ` +
            `${reason}. Flagged for a reset by the auditor.`,
    }),
  });
}

/**
 * Read a small JSON export of stuck actions. Each row looks like:
 * { "actionId": 4821, "status": "in-progress", "ageMinutes": 55, "orderId": 9321 }
 * Produce this with:
 *   wp action-scheduler action list --status=in-progress --format=json
 * then add ageMinutes and orderId per hook args, or adapt this loader to your
 * own store's export shape.
 */
async function stuckActionsFromExport(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

export async function run(exportPath = "stuck.json") {
  let handled = 0;
  for (const action of await stuckActionsFromExport(exportPath)) {
    const orderId = action.orderId;
    const order = orderId ? await woo(`/orders/${orderId}`) : null;
    const intent = order ? await getIntent(intentIdOf(order)) : null;
    const [verdict, reason] = decide(action, order, intent);
    if (verdict === "skip" || verdict === "wait") continue;
    console.log(
      `Action ${action.actionId} (order ${orderId}): ${reason} -> ${DRY_RUN ? "would act" : "acting"}`
    );
    if (!DRY_RUN) {
      if (verdict === "complete_order") await completeOrder(orderId, intent);
      else if (verdict === "reset_action" || verdict === "investigate") await noteStuckAction(orderId, reason);
    }
    handled++;
  }
  console.log(`Done. ${handled} stuck action(s) ${DRY_RUN ? "to handle" : "handled"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv[2]).catch((e) => { console.error(e); process.exit(1); });
}
