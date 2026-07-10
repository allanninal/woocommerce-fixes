/**
 * Link guest WooCommerce orders to the account that shares the same email.
 *
 * A guest checkout never sets order.customer_id, even when the billing email
 * matches a real, registered customer. The order sits at customer_id 0 forever,
 * so it never shows up in "My account", loyalty points never accrue, and any
 * per-customer report undercounts that shopper. This walks recent guest orders,
 * looks up a customer by billing email through the WooCommerce REST API, and
 * confirms the order was really paid by checking the saved Stripe PaymentIntent
 * before relinking it. Safe to run again and again. Dry run by default.
 *
 * Guide: https://www.allanninal.dev/woocommerce/guest-orders-not-linked-to-accounts/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const REQUIRE_PAID = (process.env.REQUIRE_PAID || "true").toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/** Pure decision. customers is the list returned for the billing email lookup. */
export function decide(order, customers, intent = null) {
  if (order.customer_id) return ["skip", "order is already linked to an account"];
  const email = (order.billing || {}).email;
  if (!email) return ["skip", "no billing email on the order"];
  if (REQUIRE_PAID && !PAID_STATUSES.has(order.status)) return ["skip", "order is not paid yet"];
  if (!customers || customers.length === 0) return ["no_account", "no registered account uses this email"];
  if (customers.length > 1) return ["ambiguous", "more than one account uses this email"];
  if (REQUIRE_PAID) {
    if (!intent) return ["unverified", "no Stripe PaymentIntent saved on the order"];
    if (intent.status !== "succeeded") return ["unverified", "Stripe does not show this payment as succeeded"];
    if (Math.abs(orderAmountMinor(order) - (intent.amount_received || 0)) > 1) {
      return ["unverified", "order total does not match the Stripe charge"];
    }
  }
  return ["link", `billing email matches account ${customers[0].id}`];
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

async function findCustomersByEmail(email) {
  return woo(`/customers?email=${encodeURIComponent(email)}&per_page=10`);
}

async function* guestOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?customer=0&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function linkOrder(orderId, customerId) {
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ customer_id: customerId }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Linked this guest order to account ${customerId} because the billing email ` +
            `matched a registered customer. Linked by the reconciler.`,
    }),
  });
}

export async function run() {
  let linked = 0;
  for await (const order of guestOrders()) {
    const email = (order.billing || {}).email;
    const customers = email ? await findCustomersByEmail(email) : [];
    const intent = REQUIRE_PAID ? await getIntent(intentIdOf(order)) : null;
    const [action, reason] = decide(order, customers, intent);
    if (action === "link") {
      const customerId = customers[0].id;
      console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would link" : "linking"}`);
      if (!DRY_RUN) await linkOrder(order.id, customerId);
      linked++;
    } else if (action === "ambiguous" || action === "unverified") {
      console.warn(`Order ${order.id} not linked: ${reason}`);
    }
  }
  console.log(`Done. ${linked} order(s) ${DRY_RUN ? "to link" : "linked"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
