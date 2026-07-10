/**
 * Rebuild WooCommerce customer lookup rows that have drifted from real orders.
 *
 * The customer lookup table (orders_count, total_spent, last_order_date) is a cache
 * built from real orders. It is meant to update whenever an order is placed, paid,
 * refunded, or changes status, but a stuck scheduled action, a bulk import, or a
 * direct database edit can leave it holding stale numbers long after the real orders
 * moved on. This walks every customer, recalculates their real totals straight from
 * the WooCommerce REST API, compares that to the stored row, and rewrites only the
 * rows that disagree. It also checks whether the saved Stripe customer id on a
 * customer's most recent order still resolves, since a stale link is another common
 * form of the same drift. Safe by default (dry run). Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/customer-lookup-out-of-sync/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const HAS_STRIPE_KEY = Boolean(process.env.STRIPE_SECRET_KEY);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const COUNTED_STATUSES = new Set(["processing", "completed"]);

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* allCustomers() {
  let page = 1;
  while (true) {
    const batch = await woo(`/customers?per_page=50&page=${page}`);
    if (!batch.length) return;
    for (const customer of batch) yield customer;
    page++;
  }
}

async function* realOrdersFor(customerId) {
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?customer=${customerId}&per_page=50&page=${page}&status=any`);
    if (!batch.length) return;
    for (const order of batch) {
      if (COUNTED_STATUSES.has(order.status)) yield order;
    }
    page++;
  }
}

export function orderAmountMinor(order) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since 50.00 is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

export function recalcFromOrders(orders) {
  // Pure: recompute the three lookup numbers from a list of real orders.
  const count = orders.length;
  const totalMinor = orders.reduce((sum, o) => sum + orderAmountMinor(o), 0);
  const lastOrderDate = orders.length
    ? orders.map((o) => o.date_created).sort().slice(-1)[0]
    : null;
  return { ordersCount: count, totalSpentMinor: totalMinor, lastOrderDate };
}

export function storedTotalsOf(customer) {
  // Pure: normalize a WooCommerce customer record into the same shape as recalcFromOrders.
  return {
    ordersCount: customer.orders_count || 0,
    totalSpentMinor: Math.round(parseFloat(customer.total_spent || "0") * 100),
    lastOrderDate: customer.last_order_date || null,
  };
}

export function decide(stored, recalculated) {
  // Pure decision function. No I/O. Compares stored totals to a fresh recalculation.
  const storedCount = stored.ordersCount || 0;
  const storedTotal = stored.totalSpentMinor || 0;
  const storedDate = stored.lastOrderDate || null;

  const sameCount = storedCount === recalculated.ordersCount;
  const sameTotal = Math.abs(storedTotal - recalculated.totalSpentMinor) <= 1;
  const sameDate = storedDate === recalculated.lastOrderDate;

  if (sameCount && sameTotal && sameDate) {
    return ["skip", "lookup row already matches real orders"];
  }
  if (recalculated.ordersCount === 0 && storedCount > 0) {
    return ["rebuild", "stored row has orders but no real paid orders were found"];
  }
  return ["rebuild", "stored row does not match real orders"];
}

export function stripeCustomerIdOf(order) {
  // Pure: read the saved Stripe customer id from order meta, or fall back to transaction_id.
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_customer_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("cus_") ? tid : null;
}

async function stripeLinkIsValid(customerId) {
  if (!customerId || !HAS_STRIPE_KEY) return false;
  try {
    const cust = await stripe.customers.retrieve(customerId);
    return !cust.deleted;
  } catch {
    return false;
  }
}

async function rebuild(customerId, recalculated) {
  await woo(`/customers/${customerId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "orders_count", value: recalculated.ordersCount },
        { key: "total_spent", value: String(recalculated.totalSpentMinor / 100) },
        { key: "last_order_date", value: recalculated.lastOrderDate },
      ],
    }),
  });
}

export async function run() {
  let rebuilt = 0;
  for await (const customer of allCustomers()) {
    const orders = [];
    for await (const order of realOrdersFor(customer.id)) orders.push(order);
    const recalculated = recalcFromOrders(orders);
    const stored = storedTotalsOf(customer);
    const [action, reason] = decide(stored, recalculated);
    if (action === "skip") continue;

    let stripeNote = "";
    if (orders.length) {
      const custId = stripeCustomerIdOf(orders[orders.length - 1]);
      if (custId && !(await stripeLinkIsValid(custId))) {
        stripeNote = ` Saved Stripe customer id ${custId} no longer resolves.`;
      }
    }

    console.log(`Customer ${customer.id}: ${reason}.${stripeNote} ${DRY_RUN ? "would rebuild" : "rebuilding"}`);
    if (!DRY_RUN) await rebuild(customer.id, recalculated);
    rebuilt++;
  }
  console.log(`Done. ${rebuilt} customer(s) ${DRY_RUN ? "to rebuild" : "rebuilt"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
