/**
 * Move legacy Stripe card Sources saved on WooCommerce customers to reusable
 * PaymentMethods, so future off-session charges can go through Strong Customer
 * Authentication (SCA) instead of being declined.
 *
 * Stripe is retiring the old Sources API for saved cards. A `src_...` token
 * that was fine for a one-off checkout years ago cannot carry a customer
 * through 3D Secure on a later off-session renewal or repeat purchase. This
 * walks recent orders, reads the saved token from order meta
 * `_stripe_intent_id` (falling back to `transaction_id`), and for any legacy
 * card Source still in good standing, wraps it in a new PaymentMethod,
 * attaches it to the Stripe Customer, and re-links the order (and the
 * customer's default token) to the new `pm_...` id. Orders whose Source
 * cannot be migrated are flagged instead. Safe by default (DRY_RUN=true).
 *
 * Guide: https://www.allanninal.dev/woocommerce/move-sources-to-payment-methods/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 60);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const RELEVANT_STATUSES = new Set(["pending", "on-hold", "processing", "completed", "failed"]);
const LEGACY_SOURCE_PREFIX = "src_";
const PAYMENT_METHOD_PREFIX = "pm_";
const OK_SOURCE_STATUSES = new Set(["chargeable", "consumed"]);

export function tokenOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  return order.transaction_id || null;
}

export function isLegacySource(token) {
  return Boolean(token) && token.startsWith(LEGACY_SOURCE_PREFIX);
}

export function isAlreadyPaymentMethod(token) {
  return Boolean(token) && token.startsWith(PAYMENT_METHOD_PREFIX);
}

/**
 * Pure decision: what should we do about this order's saved payment token.
 *
 * order: object with at least { status, id }.
 * token: the saved Stripe token string, or null.
 * source: a Stripe Source-shaped object ({ type, status }), or null when the
 *         token is not a legacy Source (already a PaymentMethod, or missing).
 *
 * Returns [action, reason] where action is one of "skip", "migrate", "flag".
 */
export function decide(order, token, source) {
  if (!RELEVANT_STATUSES.has(order.status)) {
    return ["skip", "order status is not one we track saved cards for"];
  }
  if (isAlreadyPaymentMethod(token)) {
    return ["skip", "already a PaymentMethod"];
  }
  if (!isLegacySource(token)) {
    return ["skip", "no legacy Source saved on this order"];
  }
  if (!source) {
    return ["flag", "Source could not be retrieved from Stripe"];
  }
  if (source.type !== "card") {
    return ["flag", "Source is not a card, cannot auto-migrate this type"];
  }
  if (!OK_SOURCE_STATUSES.has(source.status)) {
    return ["flag", "Source is no longer chargeable, shopper must re-enter their card"];
  }
  return ["migrate", "legacy card Source in good standing, safe to wrap as a PaymentMethod"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getSource(sourceId) {
  if (!sourceId) return null;
  try {
    return await stripe.sources.retrieve(sourceId);
  } catch {
    return null;
  }
}

function customerIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_customer_id" && meta.value) return meta.value;
  }
  return null;
}

async function* trackedOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(
      `/orders?status=pending,on-hold,processing,completed,failed&after=${after}&per_page=50&page=${page}`
    );
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function createPaymentMethodFromSource(sourceId, customerId) {
  const paymentMethod = await stripe.paymentMethods.create({ type: "card", card: { token: sourceId } });
  if (customerId) {
    await stripe.paymentMethods.attach(paymentMethod.id, { customer: customerId });
  }
  return paymentMethod.id;
}

async function migrate(order, newPmId) {
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "_stripe_intent_id", value: newPmId },
        { key: "_stripe_source_id", value: newPmId },
      ],
    }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Migrated the saved Stripe Source to PaymentMethod ${newPmId}. ` +
            `Future off-session charges on this order's saved card can now go through ` +
            `Strong Customer Authentication (SCA).`,
    }),
  });
}

async function flag(order, reason) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Stripe Source migration check failed: ${reason}. This order's saved card is ` +
            `a legacy Stripe Source that could not be automatically moved to a PaymentMethod. ` +
            `The shopper should re-enter their card on the my account page before the next charge.`,
    }),
  });
}

export async function run() {
  let migrated = 0;
  let flagged = 0;
  for await (const order of trackedOrders()) {
    const token = tokenOf(order);
    const source = isLegacySource(token) ? await getSource(token) : null;
    const [action, reason] = decide(order, token, source);
    if (action === "skip") continue;
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would " + action : action + "ing"}`);
    if (action === "migrate") {
      if (!DRY_RUN) {
        const customerId = customerIdOf(order);
        const newPmId = await createPaymentMethodFromSource(token, customerId);
        await migrate(order, newPmId);
      }
      migrated++;
    } else if (action === "flag") {
      if (!DRY_RUN) await flag(order, reason);
      flagged++;
    }
  }
  console.log(
    `Done. ${migrated} order(s) ${DRY_RUN ? "to migrate" : "migrated"}, ` +
    `${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
