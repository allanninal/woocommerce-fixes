/**
 * Clear stale WooCommerce persistent cart meta from wp_usermeta.
 *
 * WooCommerce saves a logged in customer's cart to user meta
 * (_woocommerce_persistent_cart_<blog_id>) on every cart change so it
 * survives across sessions and devices. Nothing in core ever clears that
 * meta once the cart is abandoned or the customer stops shopping, so
 * wp_usermeta grows without bound over the life of a store. This walks
 * customers through the WooCommerce REST API, finds carts that still hold
 * real items, and clears the meta for any customer who has gone quiet past
 * a threshold. Safe by default (DRY_RUN). Run on a schedule.
 *
 * Guide: https://www.allanninal.dev/woocommerce/persistent-cart-data-never-cleared/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const STALE_DAYS = Number(process.env.STALE_DAYS || 180);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CART_META_PREFIX = "_woocommerce_persistent_cart_";

export async function* customers() {
  let page = 1;
  while (true) {
    const res = await fetch(
      `${WOO_URL}/wp-json/wc/v3/customers?per_page=50&page=${page}&orderby=registered_date`,
      { headers: { Authorization: AUTH } }
    );
    if (!res.ok) throw new Error(`Woo customers returned ${res.status}`);
    const batch = await res.json();
    if (!batch.length) return;
    for (const customer of batch) yield customer;
    page++;
  }
}

export function cartMetaOf(customer) {
  for (const meta of customer.meta_data || []) {
    if (String(meta.key || "").startsWith(CART_META_PREFIX)) return meta;
  }
  return null;
}

export async function lastActivity(customer) {
  const res = await fetch(
    `${WOO_URL}/wp-json/wc/v3/orders?customer=${customer.id}&per_page=1&orderby=date&order=desc`,
    { headers: { Authorization: AUTH } }
  );
  if (!res.ok) throw new Error(`Woo orders returned ${res.status}`);
  const orders = await res.json();
  if (orders.length) return orders[0].date_created;
  return customer.date_created;
}

export function daysSince(isoDate) {
  if (!isoDate) return null;
  const normalized = /[zZ]|[+-]\d\d:\d\d$/.test(isoDate) ? isoDate : `${isoDate}Z`;
  const dt = new Date(normalized);
  return Math.floor((Date.now() - dt.getTime()) / 86400000);
}

export function cartHasItems(cartMeta) {
  const value = cartMeta ? cartMeta.value : null;
  if (!value || typeof value !== "object") return false;
  return Boolean(value.cart && Object.keys(value.cart).length);
}

/**
 * Pure decision function: no I/O, safe to unit test.
 * Returns [action, reason] where action is "skip" or "clear".
 */
export function decide(cartMeta, daysQuiet, staleDays) {
  if (!cartMeta) return ["skip", "no persistent cart meta"];
  if (!cartHasItems(cartMeta)) return ["skip", "cart meta is empty"];
  if (daysQuiet === null || daysQuiet === undefined || daysQuiet < staleDays) {
    return ["skip", "customer has not been quiet long enough"];
  }
  return ["clear", `quiet for ${daysQuiet} days, past the ${staleDays} day threshold`];
}

export async function clearCart(customerId, metaKey) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3/customers/${customerId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: AUTH },
    body: JSON.stringify({ meta_data: [{ key: metaKey, value: "" }] }),
  });
  if (!res.ok) throw new Error(`Woo customer update returned ${res.status}`);
}

export async function run() {
  let cleared = 0;
  for await (const customer of customers()) {
    const cartMeta = cartMetaOf(customer);
    const daysQuiet = cartMeta ? daysSince(await lastActivity(customer)) : null;
    const [action, reason] = decide(cartMeta, daysQuiet, STALE_DAYS);
    if (action === "skip") continue;
    console.log(`Customer ${customer.id}: ${reason}. ${DRY_RUN ? "would clear" : "clearing"}`);
    if (!DRY_RUN) await clearCart(customer.id, cartMeta.key);
    cleared++;
  }
  console.log(`Done. ${cleared} customer(s) ${DRY_RUN ? "to clear" : "cleared"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
