/**
 * Resume WooCommerce subscriptions left Pending after a verified card change.
 * Confirms the SetupIntent succeeded and its card matches before resuming.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/card-change-flips-sub-to-pending/
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

/** Yield every WooCommerce subscription currently on Pending, paging through the API. */
export async function* pendingSubscriptions() {
  let page = 1;
  while (true) {
    const subs = await woo(`/subscriptions?status=pending&per_page=50&page=${page}`);
    if (!subs.length) return;
    for (const sub of subs) yield sub;
    page++;
  }
}

/** Read one value out of a WooCommerce meta_data list by its key. */
export function getMeta(sub, key) {
  const hit = (sub.meta_data || []).find((m) => m.key === key);
  return hit ? hit.value : null;
}

/** The saved Stripe SetupIntent id, from meta _stripe_intent_id or transaction_id. */
export function intentIdOf(sub) {
  const metaId = getMeta(sub, "_stripe_intent_id");
  if (metaId) return metaId;
  const tid = sub.transaction_id;
  return tid && tid.startsWith("seti_") ? tid : null;
}

/** The Stripe payment method token currently saved on the subscription, if any. */
export function currentCardToken(sub) {
  return getMeta(sub, "_stripe_source_id") || getMeta(sub, "_payment_method_token");
}

async function getSetupIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.setupIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

/**
 * Pure decision function. No I/O, safe to unit test.
 *
 * Returns a tuple of [action, reason] where action is one of:
 *   "skip"     - the subscription is not pending, nothing to do
 *   "wait"     - still waiting on the SetupIntent to resolve, leave it alone
 *   "mismatch" - the SetupIntent's card does not match what is saved, needs a human
 *   "resume"   - proven safe to set the subscription back to active
 */
export function decide(subStatus, intent, currentCardToken) {
  if (subStatus !== "pending") return ["skip", "subscription not pending"];
  if (!intent) return ["wait", "no setup intent on file yet"];
  if (intent.status !== "succeeded") return ["wait", "setup intent has not succeeded"];
  const intentPm = intent.payment_method;
  if (!intentPm || !currentCardToken) return ["mismatch", "missing payment method to compare"];
  if (intentPm !== currentCardToken) return ["mismatch", "setup intent card does not match saved card"];
  return ["resume", "card change verified, safe to reactivate"];
}

/** Set the subscription back to active and leave a note explaining why. */
async function resume(subId, intentId) {
  await woo(`/subscriptions/${subId}`, { method: "PUT", body: JSON.stringify({ status: "active" }) });
  await woo(`/subscriptions/${subId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Card change verified on Stripe SetupIntent ${intentId}. ` +
            `The confirmation back to the store was missed, so this was ` +
            `set back to active by the reconciler.`,
    }),
  });
}

export async function run() {
  let resumed = 0;
  for await (const sub of pendingSubscriptions()) {
    const intentId = intentIdOf(sub);
    const intent = await getSetupIntent(intentId);
    const [action, reason] = decide(sub.status, intent, currentCardToken(sub));
    if (action === "skip" || action === "wait") continue;
    if (action === "mismatch") { console.warn(`Subscription ${sub.id}: ${reason}`); continue; }
    console.log(`Subscription ${sub.id}: ${reason}. ${DRY_RUN ? "would resume" : "resuming"}`);
    if (!DRY_RUN) await resume(sub.id, intentId);
    resumed++;
  }
  console.log(`Done. ${resumed} subscription(s) ${DRY_RUN ? "to resume" : "resumed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
