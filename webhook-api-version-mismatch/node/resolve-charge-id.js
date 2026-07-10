/**
 * Repair WooCommerce orders dropped by a Stripe API version mismatch.
 *
 * Older Stripe API versions (before 2022-11-15) returned a `charges` list on
 * every PaymentIntent, so `intent.charges.data[0].id` worked. On newer API
 * versions that list is gone by default; the charge lives on
 * `intent.latest_charge` instead. A webhook handler or script still written
 * for the old shape reads an empty `charges` list, decides there is no
 * charge yet, and skips the order, so it never gets a transaction id and can
 * be left on Pending even though Stripe already has a succeeded charge.
 *
 * This walks orders that have a saved PaymentIntent id but no transaction
 * id, reads the intent from Stripe, resolves the charge id from whichever
 * field is present, and writes it onto the order along with a note. Safe to
 * run again and again. Read only until DRY_RUN is turned off.
 *
 * Guide: https://www.allanninal.dev/woocommerce/webhook-api-version-mismatch/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Resolve a charge id from a PaymentIntent regardless of API version.
 *
 * Newer API versions (2022-11-15 and later) put the charge on
 * `latest_charge`. Older versions only have the `charges` list. Try the
 * new field first since it is a plain string on every supported version
 * once it exists, then fall back to the legacy nested list.
 */
export function chargeIdOf(intent) {
  const latest = intent.latest_charge;
  if (typeof latest === "string" && latest) return latest;
  if (latest && typeof latest === "object" && latest.id) return latest.id;
  const data = (intent.charges && intent.charges.data) || [];
  if (data.length && data[0].id) return data[0].id;
  return null;
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/** Pure decision. No I/O. Returns [action, reason]. */
export function decide(order, intent) {
  if (intentIdOf(order) === null) return ["skip", "no saved PaymentIntent id on this order"];
  if (order.transaction_id) return ["skip", "order already has a transaction id"];
  if (!intent) return ["skip", "PaymentIntent not found on Stripe"];
  if (intent.status !== "succeeded") return ["skip", "PaymentIntent is not succeeded yet"];
  const chargeId = chargeIdOf(intent);
  if (chargeId === null) return ["orphan", "succeeded but no charge id on either API shape"];
  if (Math.abs(orderAmountMinor(order) - (intent.amount_received || 0)) > 1) {
    return ["mismatch", "amount does not match the PaymentIntent"];
  }
  return ["repair", "succeeded in Stripe, charge id was never saved"];
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

async function* candidateOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function applyChargeId(orderId, chargeId, intentId) {
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "processing", transaction_id: chargeId }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Recovered charge ${chargeId} from PaymentIntent ${intentId}. ` +
            `The webhook handler could not read the newer API response shape, ` +
            `this was backfilled by the reconciler.`,
    }),
  });
}

export async function run() {
  let repaired = 0;
  for await (const order of candidateOrders()) {
    const intentId = intentIdOf(order);
    if (intentId === null) continue;
    const intent = await getIntent(intentId);
    const [action, reason] = decide(order, intent);
    if (action === "orphan") { console.warn(`Order ${order.id}: ${reason}`); continue; }
    if (action === "skip" || action === "mismatch") {
      if (action === "mismatch") console.warn(`Order ${order.id} amount mismatch: ${reason}`);
      continue;
    }
    const chargeId = chargeIdOf(intent);
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would repair" : "repairing"}`);
    if (!DRY_RUN) await applyChargeId(order.id, chargeId, intentId);
    repaired++;
  }
  console.log(`Done. ${repaired} order(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
