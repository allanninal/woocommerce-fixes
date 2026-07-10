/**
 * Bulk swap subscriptions off a reissued Stripe card range onto each customer's
 * current default payment method.
 *
 * An issuer notice or a Stripe card updater event names a batch of old payment_method
 * ids (or fingerprints) that no longer work. Any active subscription still storing one
 * of those old ids as its payment token will decline on its next renewal. This walks
 * the affected subscriptions, reads the matching Stripe Customer, and swaps the
 * subscription onto the customer's current default payment method, but only when that
 * default is a real, different, non-affected card. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/bulk-swap-a-reissued-card-range/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ACTIVE_SUB_STATUSES = new Set(["active", "on-hold", "pending"]);

export function getMeta(obj, key) {
  for (const meta of obj.meta_data || []) {
    if (meta.key === key) return meta.value;
  }
  return null;
}

export function currentCardToken(sub) {
  return getMeta(sub, "_stripe_source_id");
}

export function customerIdOf(sub) {
  return getMeta(sub, "_stripe_customer_id");
}

/**
 * Pure decision function. No I/O. Returns [action, reason].
 *
 * sub: an object with at least "status" and meta_data carrying _stripe_source_id.
 * affectedTokenIds: a Set of old payment_method ids from the reissued range.
 * defaultPaymentMethod: the customer's current default PaymentMethod object
 *   (or null), already resolved by the caller.
 */
export function decide(sub, affectedTokenIds, defaultPaymentMethod) {
  if (!ACTIVE_SUB_STATUSES.has(sub.status)) {
    return ["skip", "subscription not in an active state"];
  }
  const token = currentCardToken(sub);
  if (!token) return ["skip", "no stored payment token on this subscription"];
  if (!affectedTokenIds.has(token)) return ["skip", "not on the reissued card range"];
  if (!defaultPaymentMethod) {
    return ["needs-attention", "no replacement card on file for this customer"];
  }
  const newToken = defaultPaymentMethod.id;
  if (!newToken || affectedTokenIds.has(newToken)) {
    return ["needs-attention", "customer default is missing or also on the reissued range"];
  }
  if (newToken === token) return ["skip", "already on the new token"];
  return ["swap", "reissued card on file, a clean replacement is ready"];
}

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
    const batch = await woo(`/subscriptions?status=active,on-hold,pending&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const sub of batch) yield sub;
    page++;
  }
}

async function getCustomerDefaultPaymentMethod(customerId) {
  if (!customerId) return null;
  let customer;
  try {
    customer = await stripe.customers.retrieve(customerId);
  } catch {
    return null;
  }
  const defaultId =
    (customer.invoice_settings && customer.invoice_settings.default_payment_method) ||
    customer.default_source;
  if (!defaultId) return null;
  try {
    return await stripe.paymentMethods.retrieve(defaultId);
  } catch {
    return null;
  }
}

async function applySwap(subId, newToken, oldToken) {
  await woo(`/subscriptions/${subId}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: "_stripe_source_id", value: newToken }] }),
  });
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Reissued card ${oldToken} swapped for ${newToken} by the bulk card range ` +
            `reconciler. Next renewal will charge the new card.`,
    }),
  });
}

async function flagNeedsAttention(subId, reason) {
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Card range reissue: ${reason}. This subscription is on an old, reissued ` +
            `card and has no safe replacement on file. Please contact the customer for ` +
            `a new card before the next renewal.`,
    }),
  });
}

function loadAffectedTokenIds() {
  const raw = process.env.AFFECTED_PAYMENT_METHOD_IDS || "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export async function run() {
  const affected = loadAffectedTokenIds();
  if (affected.size === 0) {
    console.warn("AFFECTED_PAYMENT_METHOD_IDS is empty, nothing to do.");
    return;
  }
  let swapped = 0;
  let flagged = 0;
  for await (const sub of activeSubscriptions()) {
    const token = currentCardToken(sub);
    if (!affected.has(token)) continue;
    const defaultPm = await getCustomerDefaultPaymentMethod(customerIdOf(sub));
    const [action, reason] = decide(sub, affected, defaultPm);
    if (action === "skip") continue;
    if (action === "needs-attention") {
      console.warn(`Subscription ${sub.id}: ${reason}`);
      if (!DRY_RUN) await flagNeedsAttention(sub.id, reason);
      flagged++;
      continue;
    }
    const newToken = defaultPm.id;
    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would swap" : "swapping"}`);
    if (!DRY_RUN) await applySwap(sub.id, newToken, token);
    swapped++;
  }
  console.log(
    `Done. ${swapped} subscription(s) ${DRY_RUN ? "to swap" : "swapped"}, ` +
    `${flagged} flagged for manual follow up.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
