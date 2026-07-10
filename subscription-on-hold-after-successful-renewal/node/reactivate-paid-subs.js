/**
 * Reactivate WooCommerce subscriptions that stayed On-Hold after a paid renewal.
 * Confirms payment first, so it only fixes subscriptions that were genuinely paid.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/subscription-on-hold-after-successful-renewal/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function shouldReactivate(subStatus, latestRenewalPaid, stripeActiveAndPaid) {
  if (subStatus !== "on-hold") return false;
  return Boolean(latestRenewalPaid || stripeActiveAndPaid);
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
    const subs = await woo(`/subscriptions?status=on-hold&per_page=50&page=${page}`);
    if (!subs.length) return;
    for (const sub of subs) yield sub;
    page++;
  }
}

async function latestRenewalPaid(sub) {
  const order = await woo(`/orders/${sub.last_order_id || sub.parent_id}`);
  return Boolean(order) && PAID_STATUSES.has(order.status);
}

function getMeta(sub, key) {
  const hit = (sub.meta_data || []).find((m) => m.key === key);
  return hit ? hit.value : null;
}

async function stripeActiveAndPaid(sub) {
  const subId = getMeta(sub, "_wcpay_subscription_id") || getMeta(sub, "_stripe_subscription_id");
  if (!subId || !process.env.STRIPE_SECRET_KEY) return false;
  const s = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
  const invoice = s.latest_invoice || {};
  return ["active", "trialing"].includes(s.status) && invoice.status === "paid";
}

async function reactivate(subId) {
  await woo(`/subscriptions/${subId}`, { method: "PUT", body: JSON.stringify({ status: "active" }) });
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({ note: "Renewal was paid but the subscription stayed on-hold. Set back to active by the reconciler." }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const sub of onHoldSubscriptions()) {
    const paidOrder = await latestRenewalPaid(sub);
    const paidStripe = paidOrder ? false : await stripeActiveAndPaid(sub);
    if (!shouldReactivate(sub.status, paidOrder, paidStripe)) continue;
    console.log(`Subscription ${sub.id}: paid but on-hold. ${DRY_RUN ? "would reactivate" : "reactivating"}`);
    if (!DRY_RUN) await reactivate(sub.id);
    fixed++;
  }
  console.log(`Done. ${fixed} subscription(s) ${DRY_RUN ? "to reactivate" : "reactivated"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
