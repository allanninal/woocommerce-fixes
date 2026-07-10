/**
 * Recover the Stripe card for WooCommerce subscriptions that lost it,
 * so automatic renewals can run again.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/subscription-missing-saved-card-token/
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

export function getMeta(record, key) {
  const hit = (record.meta_data || []).find((m) => m.key === key);
  return hit ? hit.value : null;
}

export function needsTokenBackfill(sub) {
  if (!sub.payment_method.startsWith("stripe")) return false;
  if (!["active", "on-hold"].includes(sub.status)) return false;
  return !getMeta(sub, "_stripe_customer_id");
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

async function* subscriptions() {
  let page = 1;
  while (true) {
    const subs = await woo(`/subscriptions?status=active,on-hold&per_page=50&page=${page}`);
    if (!subs.length) return;
    for (const sub of subs) yield sub;
    page++;
  }
}

async function recoverCard(sub) {
  const parent = await woo(`/orders/${sub.parent_id}`);
  if (!parent || !PAID_STATUSES.has(parent.status)) return null;
  const intentId = getMeta(parent, "_stripe_intent_id");
  if (!intentId) return null;
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const customer = intent.customer, method = intent.payment_method;
  return customer && method ? { customer, method } : null;
}

async function backfillSub(subId, card) {
  await woo(`/subscriptions/${subId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "_stripe_customer_id", value: card.customer },
        { key: "_stripe_source_id", value: card.method },
      ],
    }),
  });
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Recovered the Stripe card (${card.method}) from the first paid order ` +
            `and put it back on the subscription so renewals can run.`,
    }),
  });
}

export async function run() {
  let fixed = 0, flagged = 0;
  for await (const sub of subscriptions()) {
    if (!needsTokenBackfill(sub)) continue;
    const card = await recoverCard(sub);
    if (!card) {
      console.warn(`Subscription ${sub.id} has no reusable card on Stripe. Flag for a customer update.`);
      flagged++;
      continue;
    }
    console.log(`Subscription ${sub.id}: recovered ${card.method}. ${DRY_RUN ? "would backfill" : "backfilling"}`);
    if (!DRY_RUN) await backfillSub(sub.id, card);
    fixed++;
  }
  console.log(`Done. ${fixed} backfilled, ${flagged} flagged ${DRY_RUN ? "(dry run)" : ""}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
