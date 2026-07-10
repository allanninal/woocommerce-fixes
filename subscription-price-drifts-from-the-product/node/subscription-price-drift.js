/**
 * Find WooCommerce Subscriptions whose recurring price no longer matches the
 * product they were created from.
 *
 * A product's regular price is changed, but every subscription already
 * running keeps billing at the price it was created with. That is normal
 * and expected for the customer's own subscription. The bug this script
 * catches is a subscription whose *stored* line item silently disagrees
 * with what was actually billed on Stripe for its last renewal, which
 * usually means an admin edit, an import, or a currency or tax change left
 * the row inconsistent.
 *
 * Read only by default. It reports every subscription whose line item price
 * does not agree with the last Stripe charge for that same subscription,
 * and can optionally realign the stored line item to match Stripe (the true
 * record of what was billed) rather than the product's current price,
 * since grandfathered pricing is intentional.
 *
 * Guide: https://www.allanninal.dev/woocommerce/subscription-price-drifts-from-the-product/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRIFT_TOLERANCE_CENTS = Number(process.env.DRIFT_TOLERANCE_CENTS || 1);
const AUTO_REPAIR = (process.env.AUTO_REPAIR || "false").toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ACTIVE_STATUSES = new Set(["active", "on-hold", "pending-cancel"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function lineItemTotalMinor(subscription) {
  return Math.round(parseFloat(subscription.total) * 100);
}

export function lastChargeAmountMinor(intent) {
  if (!intent) return null;
  return intent.amount_received ?? intent.amount ?? null;
}

export function isDrift(action) {
  return action === "drift_under_charged" || action === "drift_over_charged";
}

/**
 * Pure decision function. No I/O. Returns [action, reason].
 */
export function decide(subscription, lastOrder, intent) {
  if (!ACTIVE_STATUSES.has(subscription.status)) {
    return ["skip", "subscription is not active"];
  }
  if (!lastOrder) {
    return ["skip", "no billed order yet to compare against"];
  }
  if (!intent) {
    return ["skip", "no matching Stripe PaymentIntent for the last order"];
  }
  if (intent.status !== "succeeded") {
    return ["skip", "last PaymentIntent did not succeed"];
  }

  const subTotal = lineItemTotalMinor(subscription);
  const charged = lastChargeAmountMinor(intent);
  if (charged === null) {
    return ["skip", "Stripe intent has no charged amount"];
  }

  if (Math.abs(subTotal - charged) <= DRIFT_TOLERANCE_CENTS) {
    return ["ok", "subscription total matches the last Stripe charge"];
  }

  if (subTotal > charged) {
    return ["drift_under_charged", "subscription total is higher than what Stripe last billed"];
  }
  return ["drift_over_charged", "subscription total is lower than what Stripe last billed"];
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

async function* activeSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,on-hold,pending-cancel&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const subscription of batch) yield subscription;
    page++;
  }
}

async function getLastOrder(subscription) {
  const related = subscription.last_order_id || subscription.parent_id;
  if (!related) return null;
  return woo(`/orders/${related}`);
}

async function report(subscription, reason) {
  await woo(`/orders/${subscription.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Price drift check: ${reason}. The stored subscription total no longer ` +
            `matches what Stripe last charged for it. Please review before the next renewal.`,
    }),
  });
}

async function repair(subscription, intent) {
  const charged = lastChargeAmountMinor(intent);
  const newTotal = (charged / 100).toFixed(2);
  const lineItems = subscription.line_items || [];
  if (!lineItems.length) return;
  const firstItemId = lineItems[0].id;
  await woo(`/subscriptions/${subscription.id}`, {
    method: "PUT",
    body: JSON.stringify({
      line_items: [{ id: firstItemId, subtotal: newTotal, total: newTotal }],
    }),
  });
}

export async function run() {
  let drifted = 0;
  for await (const subscription of activeSubscriptions()) {
    const lastOrder = await getLastOrder(subscription);
    const intent = lastOrder ? await getIntent(intentIdOf(lastOrder)) : null;
    const [action, reason] = decide(subscription, lastOrder, intent);
    if (!isDrift(action)) continue;
    drifted++;
    console.warn(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would report" : "reporting"}`);
    if (!DRY_RUN) {
      await report(subscription, reason);
      if (AUTO_REPAIR) await repair(subscription, intent);
    }
  }
  console.log(`Done. ${drifted} subscription(s) ${DRY_RUN ? "to report" : "reported"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
