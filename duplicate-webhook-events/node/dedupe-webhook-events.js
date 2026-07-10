/**
 * Stop a Stripe webhook event from being applied to a WooCommerce order twice.
 *
 * Stripe retries a webhook delivery whenever it does not get a fast 2xx response,
 * and the same event id can also be redelivered after a Stripe dashboard resend or
 * a queue replay. If the handler is not idempotent, the same event.id ends up
 * applying its note, stock change, or email a second (or third) time on the order.
 *
 * This keeps a small ledger of event ids already applied to each order, read from
 * and written to the order's own meta data (no separate database needed). Before
 * doing any work for an incoming event, it checks the ledger. Read only by
 * default. Run this as the body of your webhook handler, or replay it against
 * recent events on a schedule to catch anything the live handler missed.
 *
 * Guide: https://www.allanninal.dev/woocommerce/duplicate-webhook-events/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const LEDGER_META_KEY = "_processed_webhook_event_ids";
const MAX_LEDGER_SIZE = 50;
const APPLIED_EVENT_TYPES = new Set(["payment_intent.succeeded", "charge.succeeded"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function ledgerOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === LEDGER_META_KEY && Array.isArray(meta.value)) return [...meta.value];
  }
  return [];
}

/**
 * Pure decision: should this webhook event be applied to this order?
 *
 * order  - the WooCommerce order object (or null if it could not be found)
 * event  - an object with at least { id, type } from Stripe
 * ledger - the array of event ids already recorded as applied to this order
 *
 * Returns [action, reason]. action is one of:
 *   "apply"  - event is new for this order, go ahead and act on it
 *   "skip"   - event id is already in the ledger, do nothing
 *   "ignore" - event type is not one this handler acts on
 *   "orphan" - order could not be found for this event
 */
export function decide(order, event, ledger) {
  if (!APPLIED_EVENT_TYPES.has(event.type)) return ["ignore", "event type is not handled here"];
  if (!order) return ["orphan", "order not found for this event"];
  if (ledger.includes(event.id)) return ["skip", "event id already applied to this order"];
  return ["apply", "new event for this order"];
}

/** Pure helper: the ledger after recording eventId, capped to MAX_LEDGER_SIZE. */
export function nextLedger(ledger, eventId) {
  const updated = [...ledger, eventId];
  return updated.slice(-MAX_LEDGER_SIZE);
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

async function* recentEvents(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  for await (const event of stripe.events.list({
    limit: 100,
    created: { gte: since },
    types: [...APPLIED_EVENT_TYPES],
  })) {
    yield event;
  }
}

function orderIdOfEvent(event) {
  const intent = event.data?.object || {};
  return intent.metadata?.order_id;
}

async function applyEvent(order, event) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Stripe event ${event.id} (${event.type}) applied. ` +
            `Recorded in the webhook event ledger so a retry cannot double it up.`,
    }),
  });
  const ledger = nextLedger(ledgerOf(order), event.id);
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: LEDGER_META_KEY, value: ledger }] }),
  });
}

export async function run() {
  let applied = 0;
  let skipped = 0;
  for await (const event of recentEvents(LOOKBACK_HOURS)) {
    const orderId = orderIdOfEvent(event);
    const order = orderId ? await woo(`/orders/${orderId}`) : null;
    const ledger = order ? ledgerOf(order) : [];
    const [action, reason] = decide(order, event, ledger);
    if (action === "orphan") { console.warn(`Event ${event.id} points to missing order ${orderId}`); continue; }
    if (action === "ignore") continue;
    if (action === "skip") { console.log(`Event ${event.id}: ${reason}`); skipped++; continue; }
    console.log(`Event ${event.id} on order ${orderId}: ${reason}. ${DRY_RUN ? "would apply" : "applying"}`);
    if (!DRY_RUN) await applyEvent(order, event);
    applied++;
  }
  console.log(`Done. ${applied} event(s) ${DRY_RUN ? "to apply" : "applied"}, ${skipped} duplicate(s) skipped.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
