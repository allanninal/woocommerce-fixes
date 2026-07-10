/**
 * Repoint WooCommerce subscriptions to the customer's current default Stripe card,
 * so renewals stop charging an old card the customer already replaced.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/new-card-not-linked-to-subscription/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function needsRepoint(storedToken, customerDefault) {
  if (!customerDefault) return false;
  return storedToken !== customerDefault;
}

export function getMeta(sub, key) {
  const hit = (sub.meta_data || []).find((m) => m.key === key);
  return hit ? hit.value : null;
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
    const subs = await woo(`/subscriptions?status=active&per_page=50&page=${page}`);
    if (!subs.length) return;
    for (const sub of subs) yield sub;
    page++;
  }
}

async function customerDefault(customerId) {
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId);
  return (customer.invoice_settings || {}).default_payment_method || null;
}

async function repoint(subId, newToken) {
  await woo(`/subscriptions/${subId}`, {
    method: "PUT",
    body: JSON.stringify({ meta_data: [{ key: "_stripe_source_id", value: newToken }] }),
  });
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({ note: `Repointed the subscription to the current default card ${newToken} so renewals stop charging the old one.` }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const sub of activeSubscriptions()) {
    if (!sub.payment_method.startsWith("stripe")) continue;
    const stored = getMeta(sub, "_stripe_source_id");
    const def = await customerDefault(getMeta(sub, "_stripe_customer_id"));
    if (!needsRepoint(stored, def)) continue;
    console.log(`Subscription ${sub.id}: ${stored} -> ${def}. ${DRY_RUN ? "dry run" : "repointing"}`);
    if (!DRY_RUN) await repoint(sub.id, def);
    fixed++;
  }
  console.log(`Done. ${fixed} subscription(s) ${DRY_RUN ? "to repoint" : "repointed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
