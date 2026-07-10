/**
 * Restore WooCommerce subscriptions that wrongly flipped to manual renewal.
 *
 * After a gateway change, an update, or a token migration, active subscriptions can be
 * switched to manual renewal even though they still hold a saved Stripe token. Manual
 * renewal means they stop charging on their own, so they silently lapse. This finds
 * active subscriptions that require manual renewal but still have a saved token, and
 * turns automatic renewal back on. Read only by default. Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/subscriptions-revert-to-manual-renewal/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const TOKEN_META_KEYS = ["_stripe_source_id", "_stripe_customer_id"];

export function hasSavedToken(subscription) {
  const meta = {};
  for (const m of subscription.meta_data || []) meta[m.key] = m.value;
  return TOKEN_META_KEYS.some((key) => meta[key]);
}

export function isWronglyManual(subscription) {
  if (subscription.status !== "active") return false;
  if (!subscription.requires_manual_renewal) return false;
  return hasSavedToken(subscription);
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* subscriptions() {
  let page = 1;
  while (true) {
    const batch = await woo(`/subscriptions?status=active&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const subscription of batch) yield subscription;
    page++;
  }
}

async function restoreAuto(subscriptionId) {
  await woo(`/subscriptions/${subscriptionId}`, {
    method: "PUT",
    body: JSON.stringify({ requires_manual_renewal: false }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const subscription of subscriptions()) {
    if (!isWronglyManual(subscription)) continue;
    console.warn(`Subscription ${subscription.id} is manual but has a saved token. ${DRY_RUN ? "would restore auto" : "restoring auto"}`);
    if (!DRY_RUN) await restoreAuto(subscription.id);
    fixed++;
  }
  console.log(`Done. ${fixed} subscription(s) ${DRY_RUN ? "to restore" : "restored"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
