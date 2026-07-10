/**
 * Detect a Stripe test/live key mixup on a WooCommerce store.
 *
 * A store can end up calling Stripe with a secret key from the wrong mode: a
 * test key left behind after a launch, a live key pasted into a staging site,
 * or a key rotated in one place but not the other. When that happens, every
 * charge that touches an object created in the other mode fails, and Stripe's
 * own error message says exactly why: "a similar object exists in live mode
 * [or test mode], but a test mode key [or live mode key] was used to make
 * this request." This script reads the WooCommerce Stripe gateway settings,
 * checks whether the secret key we were given matches the store's configured
 * mode, and confirms the mismatch (or clears it) by asking Stripe about a
 * recent order's PaymentIntent. It never changes a key. It only reports what
 * it finds as an order note and a log line. Read only by default. Run on
 * demand or on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/detect-test-vs-live-key-mixups/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
const stripe = new Stripe(STRIPE_SECRET_KEY);
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_ORDERS = Number(process.env.LOOKBACK_ORDERS || 20);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const MODE_MISMATCH_RE = /similar object exists in (live|test) mode/i;

export function keyMode(secretKey) {
  if (!secretKey) return "unknown";
  if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) return "test";
  if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) return "live";
  return "unknown";
}

export function gatewayTestMode(settings) {
  const value = settings && settings.testmode && settings.testmode.value;
  return String(value).toLowerCase() === "yes";
}

export function modeMismatchFromError(message) {
  if (!message) return null;
  const match = MODE_MISMATCH_RE.exec(message);
  return match ? match[1].toLowerCase() : null;
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure decision function. No I/O.
 *
 * configuredKeyMode: "test" | "live" | "unknown", from keyMode() on our own key.
 * storeTestMode: boolean, from the WooCommerce Stripe gateway's testmode setting.
 * probeErrorMessage: the Stripe error message from a live API call, if one was made,
 *                     else null/undefined when no probe was run or the probe succeeded.
 *
 * Returns [verdict, reason]:
 *   "match"              configuration and probe agree, nothing to do
 *   "config_drift"       the gateway's declared mode disagrees with our key, before
 *                         even calling Stripe. Worth fixing even if no probe ran yet.
 *   "confirmed_mismatch" a live Stripe call proved objects belong to the other mode
 *   "inconclusive"       we do not have enough signal to say either way
 */
export function decide(configuredKeyMode, storeTestMode, probeErrorMessage = null) {
  const expectedMode = storeTestMode ? "test" : "live";

  if (configuredKeyMode === "unknown") {
    return ["inconclusive", "could not read the configured key's mode"];
  }

  const probedMode = modeMismatchFromError(probeErrorMessage);
  if (probedMode !== null) {
    return [
      "confirmed_mismatch",
      `Stripe confirms the order's data lives in ${probedMode} mode, ` +
        `but the configured key is a ${configuredKeyMode} mode key`,
    ];
  }

  if (configuredKeyMode !== expectedMode) {
    return [
      "config_drift",
      `WooCommerce is set to ${expectedMode} mode but the configured ` +
        `Stripe key is a ${configuredKeyMode} mode key`,
    ];
  }

  return ["match", "configured key mode matches the store's declared mode"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getGatewaySettings() {
  const gateway = await woo("/payment_gateways/stripe");
  return gateway.settings || {};
}

async function recentOrders(limit) {
  return woo(`/orders?per_page=${limit}&orderby=date&order=desc`);
}

async function probeIntent(intentId) {
  if (!intentId) return null;
  try {
    await stripe.paymentIntents.retrieve(intentId);
    return null;
  } catch (err) {
    if (err && err.type === "StripeInvalidRequestError") return err.message;
    throw err;
  }
}

async function noteOrder(orderId, reason) {
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Key mismatch check: ${reason}. Verify the Stripe secret key ` +
            `configured for this store matches the mode (test or live) you intend to run in.`,
    }),
  });
}

export async function run() {
  const settings = await getGatewaySettings();
  const storeTestMode = gatewayTestMode(settings);
  const configuredMode = keyMode(STRIPE_SECRET_KEY);

  const [configVerdict, configReason] = decide(configuredMode, storeTestMode);
  if (configVerdict === "config_drift") {
    console.warn(`Config drift found before any Stripe call: ${configReason}`);
  } else {
    console.log(`Config check: ${configReason}`);
  }

  const orders = await recentOrders(LOOKBACK_ORDERS);
  let checked = 0;
  let confirmed = 0;
  for (const order of orders) {
    const intentId = intentIdOf(order);
    if (!intentId) continue;
    checked++;
    const errorMessage = await probeIntent(intentId);
    const [probeVerdict, probeReason] = decide(configuredMode, storeTestMode, errorMessage);
    if (probeVerdict === "confirmed_mismatch") {
      confirmed++;
      console.warn(`Order ${order.id}: ${probeReason}. ${DRY_RUN ? "would note" : "noting"}`);
      if (!DRY_RUN) await noteOrder(order.id, probeReason);
      break;
    }
  }

  console.log(
    `Done. checked ${checked} order(s), ${confirmed ? "confirmed a key mode mismatch" : "no confirmed mismatch"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
