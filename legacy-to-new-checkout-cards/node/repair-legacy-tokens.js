/**
 * Find WooCommerce saved cards that the new checkout cannot charge, and clear them
 * so the shopper is prompted to re-enter their card instead of hitting a silent decline.
 *
 * Stores that upgraded from the legacy Stripe checkout (Sources/Cards tokens saved
 * straight onto the order) to the new checkout (Payment Element, SCA-ready, backed by
 * `PaymentMethod` objects attached to a Stripe Customer) can be left with WooCommerce
 * payment tokens that still look valid in "My account" but are not attached to any
 * Stripe Customer, or were never converted to a real `pm_...` PaymentMethod. The new
 * checkout tries to reuse them for a saved-card purchase and Stripe returns an error
 * such as "PaymentMethod was previously used without being attached to a Customer &
 * Setup Intent" or "No such PaymentMethod". The shopper sees a failed order for a card
 * that "should just work".
 *
 * This script reads each customer's saved WooCommerce payment tokens, looks up the
 * matching object on Stripe, and decides whether the token is safe to keep, needs to
 * be dropped (the shopper re-enters their card next time), or should be left alone
 * because it is already a healthy PaymentMethod. Safe by default (DRY_RUN=true). Run
 * on a schedule, or once after a checkout migration.
 *
 * Guide: https://www.allanninal.dev/woocommerce/legacy-to-new-checkout-cards/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const LEGACY_TOKEN_PREFIXES = ["src_", "card_"];
const PAYMENT_METHOD_PREFIX = "pm_";

export function gatewayIdOf(token) {
  const id = (token.token || "").trim();
  return id || null;
}

export function isLegacyShaped(gatewayId) {
  return Boolean(gatewayId) && LEGACY_TOKEN_PREFIXES.some((p) => gatewayId.startsWith(p));
}

export function isPaymentMethodShaped(gatewayId) {
  return Boolean(gatewayId) && gatewayId.startsWith(PAYMENT_METHOD_PREFIX);
}

export function decide(token, stripeObject) {
  const gatewayId = gatewayIdOf(token);
  if (!gatewayId) return ["skip", "token has no gateway id"];

  if (isPaymentMethodShaped(gatewayId)) {
    if (!stripeObject) return ["drop", "PaymentMethod no longer exists on Stripe"];
    if (!stripeObject.customer) return ["drop", "PaymentMethod exists but is not attached to a Stripe Customer"];
    return ["keep", "attached PaymentMethod, safe for the new checkout"];
  }

  if (isLegacyShaped(gatewayId)) {
    if (!stripeObject) return ["drop", "legacy token no longer exists on Stripe"];
    if (stripeObject.object === "source" && stripeObject.status !== "chargeable") {
      return ["drop", "legacy Source is no longer chargeable"];
    }
    return ["drop", "legacy Source or Card token, the new checkout cannot reuse it"];
  }

  return ["skip", "not a recognized Stripe token shape"];
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

async function getStripeObject(gatewayId) {
  if (!gatewayId) return null;
  try {
    if (isPaymentMethodShaped(gatewayId)) return await stripe.paymentMethods.retrieve(gatewayId);
    return await stripe.sources.retrieve(gatewayId);
  } catch {
    return null;
  }
}

async function* customersWithTokens() {
  let page = 1;
  while (true) {
    const batch = await woo(`/customers?per_page=50&page=${page}`);
    if (!batch || !batch.length) return;
    for (const customer of batch) yield customer;
    page++;
  }
}

async function getTokens(customerId) {
  const tokens = await woo(`/customers/${customerId}/payment_tokens`);
  return tokens || [];
}

async function dropToken(customerId, tokenId, reason) {
  await woo(`/customers/${customerId}/payment_tokens/${tokenId}`, { method: "DELETE" });
  await woo(`/customers/${customerId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Removed a saved card that the new checkout could not reuse: ${reason}. ` +
            `The shopper will be asked to re-enter their card on the next purchase.`,
    }),
  });
}

export async function run() {
  let dropped = 0;
  let checked = 0;
  for await (const customer of customersWithTokens()) {
    for (const token of await getTokens(customer.id)) {
      checked++;
      const gatewayId = gatewayIdOf(token);
      const stripeObject = await getStripeObject(gatewayId);
      const [action, reason] = decide(token, stripeObject);
      if (action !== "drop") continue;
      console.log(
        `Customer ${customer.id} token ${token.id}: ${reason}. ${DRY_RUN ? "would drop" : "dropping"}`
      );
      if (!DRY_RUN) await dropToken(customer.id, token.id, reason);
      dropped++;
    }
  }
  console.log(`Done. Checked ${checked} token(s). ${dropped} ${DRY_RUN ? "to drop" : "dropped"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
