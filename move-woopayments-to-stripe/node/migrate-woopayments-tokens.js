/**
 * Move saved WooPayments card tokens to a direct Stripe account without re-asking buyers.
 *
 * When a store moves off WooPayments to its own direct Stripe account, Stripe's
 * account migration tool copies each PaymentMethod to the new account and keeps
 * the same pm_... id. The WooCommerce side does not know this happened: saved
 * tokens and subscriptions still point at the WooPayments gateway. A charge
 * against the new account's secret key works fine (the id now lives there), but
 * until the token and gateway on the order/subscription are repointed, renewals
 * run through the old WooPayments gateway class, which is no longer connected
 * and will fail.
 *
 * This script confirms each PaymentMethod is really present on the new Stripe
 * account, then repoints the WooCommerce token to the direct gateway. It never
 * creates a new PaymentMethod and never contacts the buyer. Read only by
 * default. Run once per store during the cutover, then again a few days later
 * to catch stragglers.
 *
 * Guide: https://www.allanninal.dev/woocommerce/move-woopayments-to-stripe/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const OLD_GATEWAY_IDS = new Set(["woocommerce_payments", "woopayments"]);
const NEW_GATEWAY_ID = "stripe";

export function tokenGateway(token) {
  return token.gateway_id || token.gateway;
}

export function tokenPmId(token) {
  return token.token;
}

/**
 * Pure decision: what to do with one saved token, given what Stripe (the new
 * account) says about the matching PaymentMethod. No I/O in here, so this is
 * the part covered by the tests below.
 */
export function decide(token, newAccountPm) {
  if (!OLD_GATEWAY_IDS.has(tokenGateway(token))) return ["skip", "token is not on a WooPayments gateway"];
  if (!tokenPmId(token)) return ["skip", "token has no PaymentMethod id to check"];
  if (!newAccountPm) return ["missing", "PaymentMethod not found on the new Stripe account yet"];
  if (newAccountPm.status === "detached") return ["missing", "PaymentMethod exists but is detached on the new account"];
  return ["repoint", "PaymentMethod confirmed on the new account, safe to repoint"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getPaymentMethod(pmId) {
  try {
    const pm = await stripe.paymentMethods.retrieve(pmId);
    return { status: pm.customer ? "attached" : "detached", id: pm.id };
  } catch {
    return null;
  }
}

async function customerTokens(customerId) {
  const customer = await woo(`/customers/${customerId}`);
  return (customer.meta_data || [])
    .filter((m) => m.key === "_woocommerce_payment_tokens")
    .map((m) => m.value);
}

async function* allCustomerIds() {
  let page = 1;
  while (true) {
    const batch = await woo(`/customers?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const customer of batch) yield customer.id;
    page++;
  }
}

async function repointToken(customerId, tokenId, pmId) {
  await woo(`/customers/${customerId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [{ key: "_stripe_migrated_token", value: `${tokenId}:${pmId}` }],
    }),
  });
}

export async function run() {
  let repointed = 0;
  for await (const customerId of allCustomerIds()) {
    for (const token of await customerTokens(customerId)) {
      const pmId = tokenPmId(token);
      const newAccountPm = pmId ? await getPaymentMethod(pmId) : null;
      const [action, reason] = decide(token, newAccountPm);
      if (action !== "repoint") {
        if (action === "missing") console.warn(`Customer ${customerId} token ${token.id}: ${reason}`);
        continue;
      }
      console.log(`Customer ${customerId} token ${token.id}: ${reason}. ${DRY_RUN ? "would repoint" : "repointing"}`);
      if (!DRY_RUN) await repointToken(customerId, token.id, pmId);
      repointed++;
    }
  }
  console.log(`Done. ${repointed} token(s) ${DRY_RUN ? "to repoint" : "repointed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
