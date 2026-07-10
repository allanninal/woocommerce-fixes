/**
 * Find and remove invisible auto-draft WooCommerce orders.
 *
 * The block based checkout, and some older plugins, create an order the
 * moment a buyer opens the checkout page, before they pay anything. That
 * order sits with status "auto-draft" (also seen as "checkout-draft"). It
 * never shows in the Orders list, so nobody notices it, but it stays in the
 * database forever unless something cleans it up. On a busy store this can
 * be thousands of rows.
 *
 * This walks orders in those two hidden statuses, skips anything with an
 * attached Stripe PaymentIntent that is actually in progress or already
 * paid (so a real, in-flight checkout is never touched), and deletes the
 * rest once they are older than a safety window. Read only by default.
 * Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/invisible-auto-draft-orders/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DRAFT_STATUSES = new Set(["auto-draft", "checkout-draft"]);
const IN_PROGRESS_INTENT_STATUSES = new Set([
  "requires_payment_method", "requires_confirmation", "requires_action",
  "processing", "requires_capture", "succeeded",
]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function ageHours(order, now = Date.now() / 1000) {
  const created = order.date_created_gmt || order.date_created;
  if (!created) return 0;
  const createdTs = Date.parse(created.endsWith("Z") ? created : `${created}Z`) / 1000;
  return Math.max(0, (now - createdTs) / 3600);
}

/**
 * Pure decision: what should happen to one draft order.
 * Returns [action, reason]. action is one of "skip", "keep", "delete".
 */
export function decide(order, intent, now = Date.now() / 1000, maxAgeHours = MAX_AGE_HOURS) {
  if (!DRAFT_STATUSES.has(order.status)) return ["skip", "order is not an auto-draft"];
  if (intent && IN_PROGRESS_INTENT_STATUSES.has(intent.status)) {
    return ["keep", "a Stripe PaymentIntent is still in progress or paid"];
  }
  if (ageHours(order, now) < maxAgeHours) return ["keep", "draft is younger than the safety window"];
  return ["delete", "stale draft with no live payment attempt"];
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

async function* draftOrders() {
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=auto-draft,checkout-draft&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function deleteOrder(orderId) {
  await woo(`/orders/${orderId}?force=true`, { method: "DELETE" });
}

export async function run() {
  let removed = 0;
  for await (const order of draftOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action !== "delete") continue;
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would delete" : "deleting"}`);
    if (!DRY_RUN) await deleteOrder(order.id);
    removed++;
  }
  console.log(`Done. ${removed} order(s) ${DRY_RUN ? "to delete" : "deleted"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
