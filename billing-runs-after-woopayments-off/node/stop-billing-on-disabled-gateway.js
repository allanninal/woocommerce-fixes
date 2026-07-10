/**
 * Stop WooCommerce Subscriptions from trying to auto bill through a gateway
 * you have disabled, such as WooPayments. Moves affected subscriptions to
 * manual renewal without changing price, next payment date, or line items.
 *
 * Guide: https://www.allanninal.dev/woocommerce/billing-runs-after-woopayments-off/
 *
 * Read only unless DRY_RUN is set to "false". Safe to run again and again,
 * since it skips any subscription already on manual renewal or already on a
 * gateway that is still enabled.
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DISABLED_GATEWAYS = (process.env.DISABLED_GATEWAYS || "woocommerce_payments")
  .split(",").map((g) => g.trim()).filter(Boolean);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const BILLABLE_STATUSES = new Set(["active", "on-hold"]);

/** True when the subscription is already set to require manual renewal. */
export function isManual(subscription) {
  const value = subscription.requires_manual_renewal;
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * Pure decision: should this subscription be moved to manual renewal?
 * No I/O. Takes plain objects so it is trivial to unit test.
 */
export function decide(subscription, disabledGateways) {
  if (!BILLABLE_STATUSES.has(subscription.status)) return ["skip", "subscription is not billable"];
  if (isManual(subscription)) return ["skip", "already set to manual renewal"];
  const method = subscription.payment_method || "";
  if (!disabledGateways.includes(method)) return ["skip", "payment method is not a disabled gateway"];
  return ["repair", `payment method '${method}' is disabled, would auto bill and fail`];
}

/** The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id. */
export function intentIdOf(order) {
  for (const meta of (order && order.meta_data) || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order && order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
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

async function* billableSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,on-hold&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function setManualRenewal(subscriptionId, method) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ requires_manual_renewal: true }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Moved to manual renewal. Payment method '${method}' is disabled, ` +
            `so automatic renewal would keep failing. Price and next payment date were not changed.`,
    }),
  });
}

export async function run() {
  let repaired = 0;
  for await (const subscription of billableSubscriptions()) {
    const [action, reason] = decide(subscription, DISABLED_GATEWAYS);
    if (action !== "repair") continue;
    const lastOrder = subscription.last_order;
    const intent = lastOrder && typeof lastOrder === "object" ? await getIntent(intentIdOf(lastOrder)) : null;
    const detail = intent ? ` Last attempt on Stripe: ${intent.status}.` : "";
    console.warn(`Subscription ${subscription.id}: ${reason}.${detail} ${DRY_RUN ? "would repair" : "repairing"}`);
    if (!DRY_RUN) await setManualRenewal(subscription.id, subscription.payment_method || "");
    repaired++;
  }
  console.log(`Done. ${repaired} subscription(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
