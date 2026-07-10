/**
 * Find WooCommerce subscriptions that started on iDEAL or Bancontact and have
 * no reusable payment method on file before their next renewal date.
 *
 * iDEAL and Bancontact are one off, redirect based methods. Stripe does not
 * attach a reusable payment method to the customer behind either one, so a
 * subscription stuck on one of them will fail its next automatic renewal
 * unless a human asks the customer to add a card first. Read only by
 * default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/ideal-and-bancontact-for-renewals/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const RENEWAL_WINDOW_DAYS = Number(process.env.RENEWAL_WINDOW_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ONE_OFF_METHOD_TYPES = new Set(["ideal", "bancontact"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* dueSoonSubscriptions(windowDays) {
  const cutoff = Date.now() + windowDays * 86400000;
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active&per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const sub of batch) {
      const nextPayment = sub.next_payment_date_gmt;
      if (nextPayment && new Date(nextPayment + "Z").getTime() <= cutoff) yield sub;
    }
    page++;
  }
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId, { expand: ["payment_method"] });
  } catch {
    return null;
  }
}

async function hasReusableMethod(customerId) {
  if (!customerId) return false;
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: "card" });
  return methods.data.length > 0;
}

export function daysUntil(nextPaymentDateGmt) {
  const when = new Date(nextPaymentDateGmt + "Z").getTime();
  return Math.max(0, Math.floor((when - Date.now()) / 86400000));
}

/**
 * Pure decision function. No I/O. Returns [action, reason].
 * action is one of "flag", "ok", "skip".
 */
export function decide(subscription, intent, hasReusable, daysUntilRenewal) {
  if (!intent) return ["skip", "no PaymentIntent found for the first order"];
  const methodTypes = new Set(intent.payment_method_types || []);
  const isOneOff = [...methodTypes].some((t) => ONE_OFF_METHOD_TYPES.has(t));
  if (!isOneOff) return ["skip", "first payment used a reusable method"];
  if (hasReusable) return ["ok", "a reusable card is already on file"];
  const windowDays = subscription.renewal_window_days || RENEWAL_WINDOW_DAYS;
  if (daysUntilRenewal > windowDays) return ["skip", "renewal is not close enough yet"];
  return ["flag", "one off method with no reusable card before renewal"];
}

async function flagSubscription(subscriptionId, orderId, reason) {
  const note = `Renewal risk: ${reason}. The first payment used a one off method ` +
    `(iDEAL or Bancontact) and no reusable card is on file. ` +
    `Ask the customer to add a card before the next renewal date.`;
  await woo(`/orders/${subscriptionId}/notes`, { method: "POST", body: JSON.stringify({ note }) });
  if (orderId && orderId !== subscriptionId) {
    await woo(`/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ note }) });
  }
}

export async function run() {
  let flagged = 0;
  for await (const sub of dueSoonSubscriptions(RENEWAL_WINDOW_DAYS)) {
    const parentOrderId = sub.parent_id || sub.id;
    const order = await woo(`/orders/${parentOrderId}`);
    const intent = order ? await getIntent(intentIdOf(order)) : null;
    const customerId = intent ? intent.customer : null;
    const reusable = await hasReusableMethod(customerId);
    const remaining = daysUntil(sub.next_payment_date_gmt);
    const [action, reason] = decide(sub, intent, reusable, remaining);
    if (action !== "flag") continue;
    console.warn(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
    if (!DRY_RUN) await flagSubscription(sub.id, parentOrderId, reason);
    flagged++;
  }
  console.log(`Done. ${flagged} subscription(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
