/**
 * Restore live WooCommerce subscriptions that a staging site wrongly paused.
 *
 * A staging copy of the store (built with a migration or backup plugin) can end
 * up pointed at the live WooCommerce REST API and the live Stripe account,
 * usually because the site URL was swapped but a saved API key or webhook
 * target was not. When staging's own cron runs subscription renewals, a
 * mismatched key or a stale test card makes the "payment" fail on staging, and
 * WooCommerce Subscriptions calls payment_failed() on the real, live
 * subscription. The customer was never actually charged for anything on
 * staging, but their live subscription is now On-Hold and billing has stopped.
 *
 * This script finds subscriptions that were paused by a run that did not come
 * from the live site, confirms with Stripe that the most recent invoice for
 * that subscription is genuinely paid, and restores only those to Active. Safe
 * to run again and again. Read only until DRY_RUN is turned off.
 *
 * Guide: https://www.allanninal.dev/woocommerce/staging-site-pauses-live-subs/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LIVE_SITE_HOST = process.env.LIVE_SITE_HOST || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Statuses that count as "billing is active" once we restore.
const RESTORABLE_FROM = new Set(["on-hold"]);

/** Read a value out of a WooCommerce meta_data list by key. */
export function getMeta(obj, key) {
  for (const m of obj.meta_data || []) {
    if (m.key === key) return m.value;
  }
  return null;
}

/**
 * The hostname that last paused this subscription, if the pause recorded one.
 *
 * The staging clone writes its own hostname into `_paused_by_host` meta when it
 * changes a subscription's status, the same way it would tag any other write.
 * A missing value means we cannot tell where the pause came from, so we treat
 * that as "unknown" rather than assume it is safe to touch.
 */
export function pausedByHost(sub) {
  return getMeta(sub, "_paused_by_host");
}

/** The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id. */
export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision: should this subscription be restored to active?
 *
 * sub is a WooCommerce subscription resource (object). latestInvoice is the
 * Stripe invoice for the subscription's current billing period, or null if it
 * could not be found or Stripe has no record of one. liveSiteHost is the
 * production hostname, used to tell a staging-originated pause apart from a
 * real one. Returns [action, reason] and never performs any I/O.
 */
export function decide(sub, latestInvoice, liveSiteHost) {
  if (!RESTORABLE_FROM.has(sub.status)) {
    return ["skip", "subscription is not on-hold"];
  }

  const host = pausedByHost(sub);
  if (!host) return ["skip", "no record of what paused it, leave it for manual review"];
  if (host === liveSiteHost) return ["skip", "paused by the live site, likely a real failed payment"];

  if (!latestInvoice) return ["hold", "paused by a non-live host but Stripe has no matching invoice"];
  if (latestInvoice.status !== "paid") {
    return ["hold", "paused by a non-live host and Stripe invoice is not paid either"];
  }

  return ["restore", "paused by a non-live host, but Stripe shows the invoice paid"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* onHoldSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=on-hold&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function getLatestInvoice(sub) {
  const subId = getMeta(sub, "_stripe_subscription_id") || getMeta(sub, "_wcpay_subscription_id");
  if (!subId) return null;
  try {
    const stripeSub = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
    return stripeSub.latest_invoice || null;
  } catch {
    return null;
  }
}

async function restore(subId) {
  await woo(`/subscriptions/${subId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "active" }),
  });
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "This subscription was paused by a non-live host (likely a staging copy that " +
            "shared the live API and Stripe keys). Stripe confirms the latest invoice is " +
            "paid, so it was restored to Active by the reconciler.",
    }),
  });
}

export async function run() {
  let restored = 0;
  let held = 0;
  for await (const sub of onHoldSubscriptions()) {
    const invoice = await getLatestInvoice(sub);
    const [action, reason] = decide(sub, invoice, LIVE_SITE_HOST);
    if (action === "skip") continue;
    if (action === "hold") {
      console.warn(`Subscription ${sub.id}: ${reason}. Left on-hold for manual review.`);
      held++;
      continue;
    }
    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would restore" : "restoring"}`);
    if (!DRY_RUN) await restore(sub.id);
    restored++;
  }
  console.log(`Done. ${restored} subscription(s) ${DRY_RUN ? "to restore" : "restored"}, ${held} held for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
