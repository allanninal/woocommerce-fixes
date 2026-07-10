/**
 * Line up a WooCommerce order total with a partial Stripe capture.
 *
 * A store on manual capture can capture less than the full authorized amount, for a
 * split shipment, a stock shortfall, or a deliberate partial charge. Stripe's
 * PaymentIntent then shows the real amount taken in `amount_received`, but the
 * WooCommerce order was created with the original, larger total and nothing updates
 * it. The order overstates what the buyer actually paid. This walks recent paid
 * orders, reads the saved Stripe PaymentIntent id from order meta
 * `_stripe_intent_id` (falling back to `transaction_id`), and for any order whose
 * total is higher than what Stripe actually captured, corrects the order total to
 * match and adds a note explaining the change. Safe by default, dry run first.
 *
 * Guide: https://www.allanninal.dev/woocommerce/partial-capture-total-mismatch/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const MISMATCH_TOLERANCE_MINOR = Number(process.env.MISMATCH_TOLERANCE_MINOR || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderTotalMinor(order) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since 50.00 is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

export function capturedMinor(intent) {
  return intent.amount_received || 0;
}

export function toMajorStr(minor) {
  return (minor / 100).toFixed(2);
}

export function decide(order, intent, toleranceMinor = MISMATCH_TOLERANCE_MINOR) {
  if (!PAID_STATUSES.has(order.status)) return ["skip", "order not in a paid state"];
  if (!intent) return ["skip", "no Stripe PaymentIntent id on this order"];
  if (intent.status !== "succeeded" && intent.status !== "requires_capture") {
    return ["skip", "intent has no capture to compare yet"];
  }
  if ((intent.amount_capturable || 0) > 0) {
    return ["skip", "capture is still partial in progress, more may be captured"];
  }

  const orderMinor = orderTotalMinor(order);
  const chargedMinor = capturedMinor(intent);
  const drift = orderMinor - chargedMinor;

  if (Math.abs(drift) <= toleranceMinor) return ["ok", "order total matches what Stripe captured"];
  if (drift < 0) {
    return ["flag", `order total is lower than the Stripe charge (drift ${drift} minor units)`];
  }
  return [
    "fix",
    `only ${chargedMinor} of ${orderMinor} minor units was captured, order total should drop to match`,
  ];
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

async function* paidOrders() {
  const after = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?status=processing,completed&after=${after}&per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function applyFix(order, intent, reason) {
  const newTotal = toMajorStr(capturedMinor(intent));
  await woo(`/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ total: newTotal }) });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Total corrected for a partial capture: ${reason}. Order total set to ` +
            `${newTotal} to match Stripe PaymentIntent ${intent.id}. Please review ` +
            `line items if this needs a refund too.`,
    }),
  });
}

async function flag(order, intent, reason) {
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Capture check failed: ${reason}. PaymentIntent ${intent.id}. ` +
            `Please review before shipping or refunding.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  let flagged = 0;
  for await (const order of paidOrders()) {
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action === "skip") continue;
    if (action === "flag") {
      console.warn(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would flag" : "flagging"}`);
      if (!DRY_RUN) await flag(order, intent, reason);
      flagged++;
      continue;
    }
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await applyFix(order, intent, reason);
    fixed++;
  }
  console.log(
    `Done. ${fixed} order(s) ${DRY_RUN ? "to fix" : "fixed"}, ` +
    `${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
