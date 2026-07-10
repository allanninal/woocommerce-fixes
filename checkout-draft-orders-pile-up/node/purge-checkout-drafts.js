/**
 * Clean out stale WooCommerce checkout-draft orders that never convert to a real order.
 *
 * The block based checkout (Store API) creates an order in the "checkout-draft" status
 * the moment a shopper opens the checkout page, before they pay or even enter an
 * address. Most shoppers who bounce leave that draft behind forever, since nothing in
 * WooCommerce core ever removes it. This walks old checkout-draft orders, checks
 * whether an actual payment ever happened, and trashes the ones that are safe to
 * remove. It also cancels any Stripe PaymentIntent still sitting open for that draft,
 * so it cannot be captured later by mistake. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/checkout-draft-orders-pile-up/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const STALE_AFTER_HOURS = Number(process.env.STALE_AFTER_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DRAFT_STATUS = "checkout-draft";
const PAID_INTENT_STATUSES = new Set(["succeeded", "processing"]);
const OPEN_INTENT_STATUSES = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "requires_capture",
]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function ageHours(order, nowTs) {
  const modified = order.date_modified_gmt || order.date_created_gmt;
  if (!modified) return 0;
  const dt = Date.parse(modified.endsWith("Z") ? modified : `${modified}Z`);
  return (nowTs - dt / 1000) / 3600;
}

export function decide(order, intent, nowTs, staleAfterHours = STALE_AFTER_HOURS) {
  if (order.status !== DRAFT_STATUS) return ["skip", "order is not a checkout-draft"];
  const hoursOld = ageHours(order, nowTs);
  if (hoursOld < staleAfterHours) return ["skip", "draft is still fresh"];
  if (intent && PAID_INTENT_STATUSES.has(intent.status)) {
    return ["keep", "Stripe shows a real payment on this draft"];
  }
  return ["purge", "stale draft with no completed payment"];
}

export function cancelableIntent(intent) {
  return Boolean(intent && OPEN_INTENT_STATUSES.has(intent.status));
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

async function* staleDrafts() {
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=${DRAFT_STATUS}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function purge(order, intent) {
  if (cancelableIntent(intent)) {
    await stripe.paymentIntents.cancel(intent.id);
  }
  await woo(`/orders/${order.id}?force=true`, { method: "DELETE" });
}

export async function run() {
  const nowTs = Date.now() / 1000;
  let purged = 0;
  let kept = 0;
  for await (const order of staleDrafts()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent, nowTs);
    if (action === "skip") continue;
    if (action === "keep") {
      console.log(`Order ${order.id}: ${reason}. Leaving it alone.`);
      kept++;
      continue;
    }
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would purge" : "purging"}`);
    if (!DRY_RUN) await purge(order, intent);
    purged++;
  }
  console.log(`Done. ${purged} draft(s) ${DRY_RUN ? "to purge" : "purged"}, ${kept} kept.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
