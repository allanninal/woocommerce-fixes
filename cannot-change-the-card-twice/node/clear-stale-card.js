/**
 * Find WooCommerce Subscriptions stuck on a stale saved card and clear the block.
 *
 * A subscription can end up pointing at a Stripe PaymentMethod that no longer
 * exists or no longer belongs to its Stripe Customer, for example after a
 * cleanup script or a customer portal removal. When that happens, the next
 * attempt to change the card fails silently and the subscription is stuck.
 * This walks active subscriptions, checks each saved reference against Stripe,
 * and clears any reference that is confirmed dead. Read only until DRY_RUN is
 * turned off. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/cannot-change-the-card-twice/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* activeSubscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active,on-hold&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

export function savedPaymentRef(sub) {
  const meta = Object.fromEntries((sub.meta_data || []).map((m) => [m.key, m.value]));
  const customerId = meta._stripe_customer_id || null;
  const pmId = meta._stripe_source_id || meta._payment_method_token || null;
  return { customerId, pmId };
}

async function getPaymentMethod(pmId) {
  if (!pmId) return null;
  try {
    return await stripe.paymentMethods.retrieve(pmId);
  } catch {
    return null;
  }
}

/**
 * Pure decision: what should happen to this subscription's saved card.
 * Returns a [action, reason] tuple. action is one of:
 *   skip  - nothing saved, there is nothing to repair
 *   clear - the saved reference is dead and blocking future changes
 *   ok    - the saved reference is still valid, leave it alone
 */
export function decide(customerId, pmId, paymentMethod) {
  if (!pmId || !customerId) return ["skip", "no saved payment reference on this subscription"];
  if (!paymentMethod) return ["clear", "saved PaymentMethod no longer exists in Stripe"];
  if (paymentMethod.customer !== customerId) {
    return ["clear", "saved PaymentMethod is no longer attached to this Stripe Customer"];
  }
  return ["ok", "saved PaymentMethod is still attached and valid"];
}

async function clearStaleToken(subscriptionId, pmId, reason) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "_stripe_source_id", value: "" },
        { key: "_payment_method_token", value: "" },
      ],
    }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Cleared stale saved card ${pmId}: ${reason}. ` +
            `The customer will need to add a new card on their next change payment method attempt.`,
    }),
  });
}

export async function run() {
  let cleared = 0;
  for await (const sub of activeSubscriptions()) {
    const { customerId, pmId } = savedPaymentRef(sub);
    const paymentMethod = await getPaymentMethod(pmId);
    const [action, reason] = decide(customerId, pmId, paymentMethod);
    if (action !== "clear") continue;
    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would clear" : "clearing"}`);
    if (!DRY_RUN) await clearStaleToken(sub.id, pmId, reason);
    cleared++;
  }
  console.log(`Done. ${cleared} subscription(s) ${DRY_RUN ? "to clear" : "cleared"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
