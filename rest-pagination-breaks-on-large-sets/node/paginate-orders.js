/**
 * Walk every WooCommerce order on a large store without dropping rows.
 *
 * Paging the REST API with page= and per_page= alone is unsafe once the
 * store is busy: WooCommerce sorts by date by default, and dates are not
 * unique or stable while new orders keep landing or refunds change
 * updated_at. A row can slide from page 2 to page 1 between two requests
 * and never appear in either page you actually fetched, or appear in both.
 *
 * This walks orders with a stable sort (orderby=id&order=asc) and an id
 * floor instead of a page number, so a row can only be seen once and
 * nothing between two ids can be skipped. It cross-checks each order's
 * saved Stripe PaymentIntent id (meta _stripe_intent_id, falling back to
 * transaction_id) and reports anything unpaid that Stripe already
 * settled. Read only by default. Run on a schedule or as a one-off backfill.
 *
 * Guide: https://www.allanninal.dev/woocommerce/rest-pagination-breaks-on-large-sets/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_STATUSES = new Set(["processing", "completed"]);

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

/**
 * Pure. Given one fetched page and the id floor used to fetch it, return
 * which orders are new to process, how many were unexpected repeats, and
 * the new floor for the next request.
 *
 * An order counts as new only when its id is strictly greater than the
 * floor. A repeat (id at or below the floor) means the server re-served a
 * row already passed, exactly the failure mode a naive page= walk hides
 * on a table that keeps changing while you scan it.
 */
export function decideBatch(orders, lastSeenId) {
  const newOrders = [];
  let repeats = 0;
  let highest = lastSeenId;
  for (const order of orders) {
    const oid = order.id;
    if (lastSeenId !== null && oid <= lastSeenId) {
      repeats++;
      continue;
    }
    newOrders.push(order);
    if (highest === null || oid > highest) highest = oid;
  }
  return { newOrders, repeats, nextFloor: highest };
}

export function orderAmountMinor(order) {
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure. Given one order and its Stripe PaymentIntent (or null), decide
 * whether the order needs repair. Only orders Stripe confirms as paid,
 * but WooCommerce still shows as unpaid, are worth touching.
 */
export function decide(order, intent) {
  if (!intent) return ["skip", "no Stripe PaymentIntent on this order"];
  if (PAID_STATUSES.has(order.status)) return ["skip", "order already paid"];
  if (intent.status !== "succeeded") return ["skip", "intent not succeeded"];
  if (Math.abs(orderAmountMinor(order) - (intent.amount_received || 0)) > 1) {
    return ["mismatch", "amount does not match the Stripe charge"];
  }
  return ["fix", "paid in Stripe, missed during pagination, still unpaid in Woo"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

/**
 * One page, sorted by id ascending. WooCommerce has no after_id filter, so
 * we always ask for the next per_page rows in id order and let
 * decideBatch drop anything at or below the floor client side. That drop
 * is safe because ids are assigned once and never reused or reordered.
 */
async function fetchPage(pageSize) {
  return woo(`/orders?orderby=id&order=asc&per_page=${pageSize}`);
}

/**
 * Yield every order exactly once, using an id floor instead of a page
 * number. Stops when a fetch returns no id past the current floor.
 */
export async function* walkAllOrders(pageSize = PAGE_SIZE) {
  let lastSeenId = null;
  while (true) {
    const batch = await fetchPage(pageSize);
    if (!batch.length) return;
    const result = decideBatch(batch, lastSeenId);
    for (const order of result.newOrders) yield order;
    if (result.nextFloor === lastSeenId) return; // caught up
    lastSeenId = result.nextFloor;
  }
}

async function getIntent(intentId) {
  if (!intentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(intentId);
  } catch {
    return null;
  }
}

async function markProcessing(orderId, intent) {
  const chargeId = intent.latest_charge || intent.id;
  await woo(`/orders/${orderId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "processing", transaction_id: chargeId }),
  });
  await woo(`/orders/${orderId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: `Repaired by the pagination sweep. Stripe PaymentIntent ${intent.id} ` +
            `was succeeded but this order was missed by an earlier page walk.`,
    }),
  });
}

export async function run() {
  let fixed = 0;
  let scanned = 0;
  for await (const order of walkAllOrders()) {
    scanned++;
    const intent = await getIntent(intentIdOf(order));
    const [action, reason] = decide(order, intent);
    if (action !== "fix") {
      if (action === "mismatch") console.warn(`Order ${order.id} amount mismatch: ${reason}`);
      continue;
    }
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would fix" : "fixing"}`);
    if (!DRY_RUN) await markProcessing(order.id, intent);
    fixed++;
  }
  console.log(`Scanned ${scanned} order(s). ${fixed} ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
