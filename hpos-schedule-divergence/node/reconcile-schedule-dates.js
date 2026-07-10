/**
 * Reconcile WooCommerce Subscriptions schedule dates that have drifted between
 * HPOS (the authoritative wc_orders / wc_orders_meta tables) and the legacy
 * postmeta copy that some reports, exports, and older custom code still read
 * directly.
 *
 * When the two disagree, this trusts the HPOS value from the REST API as the
 * source of truth, then cross-checks it against Stripe: it reads the linked
 * renewal order's PaymentIntent (from order meta _stripe_intent_id, falling
 * back to transaction_id) and uses the charge time on that succeeded
 * PaymentIntent to confirm the next payment date is actually in the future
 * relative to the last real charge. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/hpos-schedule-divergence/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
// How much a schedule date is allowed to drift, in seconds, before we call it wrong.
const DRIFT_TOLERANCE_SECONDS = Number(process.env.DRIFT_TOLERANCE_SECONDS || 3600);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ACTIVE_STATUSES = new Set(["active", "pending-cancel"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

function parseWooDatetime(value) {
  if (value && typeof value === "object") value = value.date;
  if (!value) return null;
  const text = value.split(".")[0];
  const iso = text.includes("T") ? text : text.replace(" ", "T");
  const ms = Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function hposNextPaymentTs(subscription) {
  return parseWooDatetime(subscription.schedule_next_payment);
}

export function metaNextPaymentTs(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_schedule_next_payment" && meta.value) return parseWooDatetime(meta.value);
  }
  return null;
}

/**
 * Pure decision function. No I/O. Returns [action, reason].
 *
 * subscription is the WooCommerce Subscriptions REST resource (HPOS backed),
 * with its meta_data array included so we can see the legacy postmeta copy.
 * lastChargeTs is the Stripe PaymentIntent charge time (epoch seconds, or
 * null) for the most recent renewal order tied to this subscription.
 *
 * Actions:
 *   skip     - subscription is not active, nothing to reconcile
 *   ok       - HPOS and postmeta agree, and the schedule is after the last charge
 *   diverged - HPOS and postmeta disagree with each other, repair postmeta from HPOS
 *   stale    - HPOS agrees with postmeta but the next payment date is not after
 *              the last real Stripe charge, flag for manual review
 */
export function decide(subscription, lastChargeTs) {
  if (!ACTIVE_STATUSES.has(subscription.status)) {
    return ["skip", "subscription is not active"];
  }

  const hposTs = hposNextPaymentTs(subscription);
  if (hposTs === null) {
    return ["skip", "no HPOS schedule date to compare"];
  }

  const metaTs = metaNextPaymentTs(subscription);
  if (metaTs !== null && Math.abs(hposTs - metaTs) > DRIFT_TOLERANCE_SECONDS) {
    return ["diverged", "HPOS schedule date and postmeta copy disagree"];
  }

  if (lastChargeTs !== null && lastChargeTs !== undefined && hposTs <= lastChargeTs) {
    return ["stale", "next payment date is not after the last succeeded Stripe charge"];
  }

  return ["ok", "HPOS and postmeta agree, and the schedule is ahead of the last charge"];
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

async function* getSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,pending-cancel&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function getLastRenewalOrder(subscription) {
  const related = subscription.related_orders || [];
  const orderId = (related.length ? related[related.length - 1] : null) || subscription.parent_id;
  if (!orderId) return null;
  return woo(`/orders/${orderId}`);
}

async function getLastChargeTs(order) {
  if (!order) return null;
  const intentId = intentIdOf(order);
  if (!intentId) return null;
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
  if (intent.status !== "succeeded") return null;
  if (intent.latest_charge) {
    try {
      const charge = await stripe.charges.retrieve(intent.latest_charge);
      return charge.created;
    } catch {
      // fall through to intent.created
    }
  }
  return intent.created;
}

async function repairPostmetaFromHpos(subscriptionId, hposTs) {
  const iso = new Date(hposTs * 1000).toISOString().replace(/\.\d+Z$/, "");
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: "_schedule_next_payment", value: iso }] }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Reconciled schedule date: postmeta was out of sync with HPOS. " +
            "The HPOS value was copied onto the legacy postmeta key.",
    }),
  });
}

async function flagForReview(subscriptionId, reason) {
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Schedule check failed: ${reason}. HPOS and postmeta agree with each ` +
            `other but the date looks wrong against Stripe. Please review.`,
    }),
  });
}

export async function run() {
  let reconciled = 0;
  let flagged = 0;
  for await (const subscription of getSubscriptions()) {
    const lastOrder = await getLastRenewalOrder(subscription);
    const lastChargeTs = await getLastChargeTs(lastOrder);
    const [action, reason] = decide(subscription, lastChargeTs);

    if (action === "skip" || action === "ok") continue;

    const subId = subscription.id;
    if (action === "diverged") {
      const hposTs = hposNextPaymentTs(subscription);
      console.log(`Subscription ${subId}: ${reason}. ${DRY_RUN ? "would repair" : "repairing"}`);
      if (!DRY_RUN) await repairPostmetaFromHpos(subId, hposTs);
      reconciled++;
    } else if (action === "stale") {
      console.warn(`Subscription ${subId}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
      if (!DRY_RUN) await flagForReview(subId, reason);
      flagged++;
    }
  }
  console.log(
    `Done. ${reconciled} subscription(s) ${DRY_RUN ? "to repair" : "repaired"}, ${flagged} flagged for review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
