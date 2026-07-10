/**
 * Resume a WooCommerce Subscriptions dunning cycle that stopped early.
 *
 * WooCommerce Subscriptions retries a failed renewal on a schedule (for example
 * attempt 1 after a day, attempt 2 after three days, attempt 3 after five days),
 * then only cancels or leaves the subscription on hold once every configured
 * attempt has run. Sometimes the schedule dies early: a cron miss, a paused
 * Action Scheduler queue, or a worker that throws before it books the next
 * retry. The subscription is left on-hold with attempts still unused, and
 * nothing tries the card again.
 *
 * This walks subscriptions that are on-hold with unused attempts, reads the
 * saved Stripe payment method from the renewal order, and if the card has not
 * already been retried since the subscription went quiet, charges the next
 * attempt itself and records it, the same way the missed retry would have.
 *
 * Read the PaymentIntent id from order meta _stripe_intent_id, falling back
 * to transaction_id. Money math stays in minor units (cents). Safe by
 * default, DRY_RUN defaults to "true".
 *
 * Guide: https://www.allanninal.dev/woocommerce/dunning-stops-before-its-attempts/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const MAX_ATTEMPTS = Number(process.env.DUNNING_MAX_ATTEMPTS || 3);
const STALL_HOURS = Number(process.env.DUNNING_STALL_HOURS || 36);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const STUCK_SUB_STATUSES = new Set(["on-hold"]);

export function metaValue(obj, key) {
  for (const meta of obj.meta_data || []) {
    if (meta.key === key && meta.value !== undefined && meta.value !== null && meta.value !== "") {
      return meta.value;
    }
  }
  return null;
}

export function intentIdOf(order) {
  const value = metaValue(order, "_stripe_intent_id");
  if (value) return value;
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function dunningAttemptCount(subscription) {
  const value = metaValue(subscription, "_dunning_attempt_count");
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

export function hoursSinceLastAttempt(subscription, nowTs) {
  const value = metaValue(subscription, "_dunning_last_attempt_ts");
  const lastTs = parseInt(value, 10);
  if (!Number.isFinite(lastTs)) return null;
  return Math.max(0, (nowTs - lastTs) / 3600);
}

export function orderAmountMinor(order) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since 50.00 is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision: should we resume dunning on this subscription right now?
 * Returns ["skip" | "wait" | "resume" | "exhausted", reason].
 */
export function decide(subscription, renewalOrder, nowTs, maxAttempts = MAX_ATTEMPTS, stallHours = STALL_HOURS) {
  if (!STUCK_SUB_STATUSES.has(subscription.status)) {
    return ["skip", "subscription is not on-hold"];
  }
  if (!renewalOrder) {
    return ["skip", "no renewal order to retry"];
  }
  const attempts = dunningAttemptCount(subscription);
  if (attempts >= maxAttempts) {
    return ["exhausted", "every configured retry attempt has already run"];
  }
  const idleHours = hoursSinceLastAttempt(subscription, nowTs);
  if (idleHours !== null && idleHours < stallHours) {
    return ["wait", "still inside the normal wait between attempts"];
  }
  return ["resume", `attempt ${attempts + 1} of ${maxAttempts} never ran`];
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

async function* onHoldSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=on-hold&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function getLastRenewalOrder(subscription) {
  const orderId = subscription.last_order_id || subscription.order_id;
  if (!orderId) return null;
  return woo(`/orders/${orderId}`);
}

async function retryCharge(subscription, order) {
  const paymentMethod = metaValue(order, "_stripe_source_id") || metaValue(order, "_payment_method_id");
  const customerId = metaValue(subscription, "_stripe_customer_id");
  return stripe.paymentIntents.create({
    amount: orderAmountMinor(order),
    currency: (order.currency || "usd").toLowerCase(),
    customer: customerId,
    payment_method: paymentMethod,
    off_session: true,
    confirm: true,
    metadata: { subscription_id: String(subscription.id), order_id: String(order.id) },
  });
}

async function recordAttempt(subscription, order, intent, nowTs) {
  const attempts = dunningAttemptCount(subscription) + 1;
  await woo(`/subscriptions/${subscription.id}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "_dunning_attempt_count", value: String(attempts) },
        { key: "_dunning_last_attempt_ts", value: String(Math.floor(nowTs)) },
      ],
    }),
  });
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: "_stripe_intent_id", value: intent.id }] }),
  });
  if (intent.status === "succeeded") {
    await woo(`/orders/${order.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "processing", transaction_id: intent.latest_charge || intent.id }),
    });
    await woo(`/subscriptions/${subscription.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "active" }),
    });
  }
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Resumed dunning attempt ${attempts}. Stripe PaymentIntent ${intent.id} came back ` +
            `${intent.status}. Triggered by the resume-dunning job because the retry schedule had gone quiet.`,
    }),
  });
}

export async function run() {
  const nowTs = Date.now() / 1000;
  let resumed = 0;
  for await (const subscription of onHoldSubscriptions()) {
    const order = await getLastRenewalOrder(subscription);
    const [action, reason] = decide(subscription, order, nowTs);
    if (action === "skip" || action === "wait") continue;
    if (action === "exhausted") {
      console.log(`Subscription ${subscription.id}: ${reason}. Leaving it for a human to cancel or retry manually.`);
      continue;
    }
    console.log(`Subscription ${subscription.id}: ${reason}. ${DRY_RUN ? "would resume" : "resuming"}`);
    if (!DRY_RUN) {
      const intentId = intentIdOf(order);
      console.log(`Last known PaymentIntent for order ${order.id} was ${intentId}`);
      const intent = await retryCharge(subscription, order);
      await recordAttempt(subscription, order, intent, nowTs);
    }
    resumed++;
  }
  console.log(`Done. ${resumed} subscription(s) ${DRY_RUN ? "to resume" : "resumed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
