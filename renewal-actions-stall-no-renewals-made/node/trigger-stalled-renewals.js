/**
 * Detect and trigger WooCommerce Subscriptions renewals whose scheduled Action
 * Scheduler action stalled and never ran.
 *
 * WooCommerce Subscriptions renews a subscription by scheduling a
 * `woocommerce_scheduled_subscription_payment` action in Action Scheduler for the
 * subscription's next payment date. If the Action Scheduler queue runner stalls
 * (WP-Cron disabled, a stuck "in-progress" claim, PHP timing out mid batch), that
 * action never fires. The subscription stays active, its next payment date drifts
 * into the past, and no renewal order and no charge are ever created.
 *
 * This script finds active subscriptions whose next payment date has passed with
 * no matching renewal order, and for each one, charges the customer's saved
 * payment method off session with Stripe and creates the renewal order over the
 * WooCommerce REST API, the same way the scheduled action would have. Read only
 * by default.
 *
 * Guide: https://www.allanninal.dev/woocommerce/renewal-actions-stall-no-renewals-made/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const GRACE_HOURS = Number(process.env.GRACE_HOURS || 6);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ACTIVE_STATUSES = new Set(["active"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

function toEpoch(gmtString) {
  if (!gmtString) return null;
  const ms = Date.parse(gmtString.endsWith("Z") ? gmtString : `${gmtString}Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

async function* stalledSubscriptions() {
  const cutoff = Math.floor(Date.now() / 1000) - GRACE_HOURS * 3600;
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) {
      const nextTs = toEpoch(sub.next_payment_date_gmt);
      if (nextTs !== null && nextTs < cutoff) yield sub;
    }
    page++;
  }
}

export function lastRenewalOrder(subscription) {
  const ids = subscription.renewal_order_ids || [];
  return ids.length ? ids[ids.length - 1] : null;
}

export function paymentMethodTokenOf(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_payment_method" && meta.value) return meta.value;
  }
  return null;
}

export function subscriptionAmountMinor(subscription) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since 50.00 is wrong for those.
  return Math.round(parseFloat(subscription.total) * 100);
}

/**
 * Pure decision: what should happen to one stalled subscription.
 * Returns [action, reason]. No I/O happens here, which is what makes it safe
 * and fast to unit test.
 */
export function decide(subscription, hasRecentRenewalOrder, paymentMethodToken) {
  if (!ACTIVE_STATUSES.has(subscription.status)) return ["skip", "subscription is not active"];
  if (hasRecentRenewalOrder) return ["skip", "a renewal order already exists for this period"];
  if (!paymentMethodToken) return ["manual", "no saved payment method, needs the customer or manual dunning"];
  if (parseFloat(subscription.total || "0") <= 0) return ["skip", "zero cost renewal, no charge needed"];
  return ["trigger", "next payment date passed with no renewal order or charge"];
}

async function chargeOffSession(customerId, paymentMethodToken, amountMinor, currency, subscriptionId) {
  return stripe.paymentIntents.create({
    amount: amountMinor,
    currency,
    customer: customerId,
    payment_method: paymentMethodToken,
    off_session: true,
    confirm: true,
    metadata: { subscription_id: String(subscriptionId), reason: "stalled_renewal_trigger" },
  });
}

async function createRenewalOrder(subscription, intent) {
  const chargeId = intent.latest_charge || intent.id;
  const order = await woo("/orders", {
    method: "POST",
    body: JSON.stringify({
      status: "processing",
      customer_id: subscription.customer_id,
      payment_method: subscription.payment_method || "stripe",
      transaction_id: chargeId,
      line_items: subscription.line_items || [],
      meta_data: [{ key: "_subscription_renewal", value: String(subscription.id) }],
    }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Renewal triggered manually after the scheduled Action Scheduler action ` +
            `stalled. Charged Stripe PaymentIntent ${intent.id}.`,
    }),
  });
  return order;
}

export async function run() {
  let triggered = 0;
  for await (const subscription of stalledSubscriptions()) {
    const renewalOrderId = lastRenewalOrder(subscription);
    const paymentMethodToken = paymentMethodTokenOf(subscription);
    const [action, reason] = decide(subscription, renewalOrderId !== null, paymentMethodToken);
    if (action === "skip") continue;
    if (action === "manual") {
      console.warn(`Subscription ${subscription.id}: ${reason}`);
      continue;
    }
    console.log(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would trigger" : "triggering"}`);
    if (!DRY_RUN) {
      const intent = await chargeOffSession(
        subscription.customer_id,
        paymentMethodToken,
        subscriptionAmountMinor(subscription),
        (subscription.currency || "usd").toLowerCase(),
        subscription.id
      );
      await createRenewalOrder(subscription, intent);
    }
    triggered++;
  }
  console.log(`Done. ${triggered} subscription(s) ${DRY_RUN ? "to trigger" : "triggered"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
