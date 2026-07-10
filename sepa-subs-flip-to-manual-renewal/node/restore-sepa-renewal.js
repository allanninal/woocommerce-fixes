/**
 * Restore automatic renewal for SEPA subscriptions an update flipped to manual.
 *
 * An update can change how WooCommerce Subscriptions checks for a saved SEPA Direct
 * Debit token, so it sets requires_manual_renewal even though the mandate is still
 * attached in Stripe. This walks active subscriptions on manual renewal, checks
 * Stripe for a real attached and enabled SEPA PaymentMethod, and restores automatic
 * renewal for the ones that have one. Never triggers a charge. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/sepa-subs-flip-to-manual-renewal/
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

export async function* manualRenewalSubs() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) {
      if (sub.requires_manual_renewal) yield sub;
    }
    page++;
  }
}

/** The saved Stripe customer id, from subscription meta _stripe_customer_id. */
export function customerIdOf(subscription) {
  for (const meta of subscription.meta_data || []) {
    if (meta.key === "_stripe_customer_id" && meta.value) return meta.value;
  }
  return null;
}

/** The first attached, non-disabled SEPA Direct Debit PaymentMethod on the customer. */
export async function activeSepaPaymentMethod(customerId) {
  if (!customerId) return null;
  for await (const pm of stripe.paymentMethods.list({ customer: customerId, type: "sepa_debit" })) {
    if (pm.customer && pm.sepa_debit && !pm.disabled) return pm;
  }
  return null;
}

/**
 * Pure decision: does this subscription need automatic renewal restored.
 * subscription: object with at least status and requires_manual_renewal.
 * paymentMethod: a Stripe PaymentMethod-like object (or null) with sepa_debit
 *   and optionally disabled.
 * Returns [action, reason]. action is one of "skip", "hold", "repair".
 */
export function decide(subscription, paymentMethod) {
  if (subscription.status !== "active") return ["skip", "subscription is not active"];
  if (!subscription.requires_manual_renewal) return ["skip", "already on automatic renewal"];
  if (!paymentMethod) return ["hold", "no attached SEPA mandate found, leaving on manual renewal"];
  if (paymentMethod.disabled) return ["hold", "SEPA mandate found but marked disabled"];
  return ["repair", "SEPA mandate is attached and enabled, restoring automatic renewal"];
}

export async function restoreAutomaticRenewal(subscriptionId, paymentMethod) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({
      requires_manual_renewal: false,
      meta_data: [
        { key: "_payment_method", value: "stripe_sepa" },
        { key: "_payment_method_title", value: "SEPA Direct Debit" },
        { key: "_stripe_source_id", value: paymentMethod.id },
      ],
    }),
  });
  await woo(`/subscriptions/${subscriptionId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Automatic renewal restored. Stripe confirms SEPA PaymentMethod ` +
            `${paymentMethod.id} is still attached and enabled. Repaired by script.`,
    }),
  });
}

export async function run() {
  let repaired = 0;
  for await (const sub of manualRenewalSubs()) {
    const customerId = customerIdOf(sub);
    const pm = await activeSepaPaymentMethod(customerId);
    const [action, reason] = decide(sub, pm);
    if (action === "skip") continue;
    if (action === "hold") { console.warn(`Subscription ${sub.id}: ${reason}`); continue; }
    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would repair" : "repairing"}`);
    if (!DRY_RUN) await restoreAutomaticRenewal(sub.id, pm);
    repaired++;
  }
  console.log(`Done. ${repaired} subscription(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
