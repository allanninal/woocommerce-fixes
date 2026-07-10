/**
 * Repair orders whose Stripe status went stale after the Clear Transients tool ran.
 *
 * WooCommerce Status, Tools, Clear transients deletes the wp_options rows for
 * `_transient_wc_*` and their `_transient_timeout_wc_*` partners. The tool matches
 * both names with one LIKE query, but WordPress writes the timeout row and the value
 * row as two separate INSERTs. If a request is killed between them (a timeout, a
 * memory limit, a second click on the same button), one row survives without its
 * partner. That surviving row is residue: WooCommerce's own transient get/set calls
 * skip a row with no timeout, so the cache never refreshes itself and quietly goes
 * stale forever.
 *
 * The customer facing version of this is a PaymentIntent status cached in order meta
 * that stops following the intent once its backing transient is half deleted. This
 * walks recent orders, reads the saved PaymentIntent id, and flags (or repairs) any
 * order whose cached status disagrees with what Stripe reports right now. Safe by
 * default. Run on a schedule after anyone runs the clear transients tool, or as a
 * weekly check.
 *
 * Guide: https://www.allanninal.dev/woocommerce/clear-transients-tool-leaves-residue/
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

// Order statuses where the cached payment state actually matters.
const LIVE_STATUSES = new Set(["pending", "on-hold", "processing", "completed"]);

// What each Woo order status implies the cached payment state should be.
const PAID_STATUSES = new Set(["processing", "completed"]);
const UNPAID_STATUSES = new Set(["pending", "on-hold"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since 50.00 is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision function. No network calls, no side effects.
 * Returns [action, reason]. action is one of: "skip", "orphan", "repair".
 */
export function decide(order, intent) {
  if (!LIVE_STATUSES.has(order.status)) {
    return ["skip", "order status is not one the cache tracks"];
  }
  if (!intent) return ["orphan", "no PaymentIntent id saved on the order"];
  if (intent.status === "succeeded") {
    if (UNPAID_STATUSES.has(order.status)) {
      if (Math.abs(orderAmountMinor(order) - (intent.amount_received || 0)) > 1) {
        return ["skip", "amount does not match, needs a human look"];
      }
      return ["repair", "Stripe succeeded but the stale cache left the order unpaid"];
    }
    return ["skip", "already matches a succeeded charge"];
  }
  if (intent.status === "canceled" || intent.status === "requires_payment_method") {
    if (PAID_STATUSES.has(order.status)) {
      return ["repair", "order is marked paid but the stale cache missed a failure or cancellation"];
    }
    return ["skip", "both sides agree the payment did not complete"];
  }
  return ["skip", "intent is still in progress, nothing stale to repair yet"];
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

async function* recentOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function repair(order, intent, reason) {
  const newStatus = intent.status === "succeeded" ? "processing" : "on-hold";
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ status: newStatus }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Transient residue repair: ${reason}. Stripe PaymentIntent ${intent.id} ` +
            `now reports ${intent.status}. Order moved to ${newStatus} to match. A stale ` +
            `cache row left behind by the Clear transients tool likely hid this.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  let orphans = 0;
  for await (const order of recentOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action === "orphan") {
      orphans++;
      console.warn(`Order ${order.id}: ${reason}`);
      continue;
    }
    if (action === "skip") continue;
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would repair" : "repairing"}`);
    if (!DRY_RUN) await repair(order, intent, reason);
    fixed++;
  }
  console.log(`Done. ${fixed} order(s) ${DRY_RUN ? "to repair" : "repaired"}, ${orphans} orphan(s) with no PaymentIntent id.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
