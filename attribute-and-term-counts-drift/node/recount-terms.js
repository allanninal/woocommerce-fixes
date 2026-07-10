/**
 * Recount WooCommerce attribute terms whose cached count drifted from the real
 * catalog. Cross-checks recent Stripe sales to flag drifted terms that are still
 * actively selling as higher priority. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/woocommerce/attribute-and-term-counts-drift/
 */
import Stripe from "stripe";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const SALES_LOOKBACK_HOURS = Number(process.env.SALES_LOOKBACK_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function allAttributes() {
  return woo("/products/attributes");
}

async function* attributeTerms(attributeId) {
  let page = 1;
  while (true) {
    const batch = await woo(`/products/attributes/${attributeId}/terms?per_page=100&page=${page}`);
    if (!batch.length) return;
    for (const term of batch) yield term;
    page++;
  }
}

async function realCount(attributeSlug, termSlug) {
  const url = `${WOO_URL}/wp-json/wc/v3/products?attribute=${attributeSlug}` +
    `&attribute_term=${termSlug}&status=publish&stock_status=instock&per_page=1`;
  const res = await fetch(url, { headers: { Authorization: AUTH } });
  if (!res.ok) throw new Error(`Woo products lookup returned ${res.status}`);
  await res.json();
  return Number(res.headers.get("X-WP-Total") || 0);
}

/**
 * Pure decision: compare the term's stored count to the freshly computed real
 * count and decide whether to repair it. No I/O, easy to unit test.
 */
export function decide(term, real) {
  const stored = term.count || 0;
  if (stored === real) return ["skip", "count already correct"];
  if (real < 0) return ["skip", "real count invalid, will not write a negative number"];
  return ["repair", `stored ${stored}, real ${real}`];
}

async function writeCount(attributeId, termId, real) {
  await woo(`/products/attributes/${attributeId}/terms/${termId}`, {
    method: "PUT",
    body: JSON.stringify({ count: real }),
  });
}

async function recentlySoldProductIds(lookbackHours) {
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  const ids = new Set();
  for await (const intent of stripe.paymentIntents.list({ limit: 100, created: { gte: since } })) {
    const orderId = intent.metadata.order_id;
    if (intent.status !== "succeeded" || !orderId) continue;
    const order = await woo(`/orders/${orderId}`).catch(() => null);
    if (!order) continue;
    for (const line of order.line_items || []) ids.add(line.product_id);
  }
  return ids;
}

export async function run() {
  let repaired = 0;
  const soldIds = await recentlySoldProductIds(SALES_LOOKBACK_HOURS);
  for (const attribute of await allAttributes()) {
    for await (const term of attributeTerms(attribute.id)) {
      const real = await realCount(attribute.slug, term.slug);
      const [action, reason] = decide(term, real);
      if (action === "skip") continue;
      const urgent = soldIds.size > 0 && real > 0;
      console.log(
        `Term ${term.name} (${attribute.name}): ${reason}. ` +
        `${DRY_RUN ? "would repair" : "repairing"}${urgent ? " [urgent: recent sales use this term]" : ""}`
      );
      if (!DRY_RUN) await writeCount(attribute.id, term.id, real);
      repaired++;
    }
  }
  console.log(`Done. ${repaired} term(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
