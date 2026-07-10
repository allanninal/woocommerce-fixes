/**
 * Find WooCommerce orders whose Analytics stats disagree with the real order,
 * the classic symptom left behind by a High-Performance Order Storage (HPOS)
 * migration, and nudge each one back into sync. Read only by default. Run on
 * a schedule or once after a migration.
 *
 * Guide: https://www.allanninal.dev/woocommerce/order-stats-wrong-after-hpos-migration/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 90);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Orders in these statuses should have a matching row in the analytics
// lookup tables with a total_sales greater than zero.
const COUNTED_STATUSES = new Set(["processing", "completed", "on-hold", "refunded"]);

export function orderAmountMinor(order) {
  // Two decimal currencies only.
  return Math.round(parseFloat(order.total) * 100);
}

export function reportAmountMinor(reportRow) {
  return Math.round(parseFloat((reportRow && reportRow.total_sales) || 0) * 100);
}

/**
 * Pure decision function. No I/O.
 *
 * order: object from GET /wp-json/wc/v3/orders/{id}
 * reportRow: object from GET /wp-json/wc-analytics/reports/orders?order_id={id}
 *            or null when no row exists for that order.
 *
 * Returns [action, reason] where action is one of:
 *   "skip"    - order status is not one Analytics is expected to count
 *   "missing" - order should be counted but has no stats row at all
 *   "resync"  - a stats row exists but disagrees with the real order
 *   "ok"      - the stats row matches the real order
 */
export function decide(order, reportRow) {
  const status = order.status;
  if (!COUNTED_STATUSES.has(status)) {
    return ["skip", "order status is not counted in Analytics"];
  }
  if (!reportRow) {
    return ["missing", "no Analytics stats row for a countable order"];
  }
  if (reportRow.status !== status) {
    return ["resync", "stats row has a stale status"];
  }
  if (Math.abs(orderAmountMinor(order) - reportAmountMinor(reportRow)) > 1) {
    return ["resync", "stats row total does not match the order total"];
  }
  return ["ok", "stats row matches the order"];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function wooAnalytics(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc-analytics${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Woo Analytics ${path} returned ${res.status}`);
  return res.json();
}

async function* listOrders(lookbackDays) {
  const after = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  let page = 1;
  while (true) {
    const batch = await woo(`/orders?after=${after}&per_page=50&page=${page}&orderby=date&order=asc`);
    if (!batch.length) return;
    for (const order of batch) yield order;
    page++;
  }
}

async function getReportRow(orderId) {
  const rows = await wooAnalytics(`/reports/orders?order_id=${orderId}&per_page=1`);
  return rows && rows.length ? rows[0] : null;
}

async function touchOrder(order) {
  // Re-save the order through the CRUD layer so WooCommerce re-fires the hooks
  // that rebuild its Analytics stats row. Setting the status to its own value
  // is enough: it is the same path the built-in "Regenerate data" tool uses
  // under the hood, just for one order instead of the whole store.
  await woo(`/orders/${order.id}`, {
    method: "PUT",
    body: JSON.stringify({ status: order.status }),
  });
  await woo(`/orders/${order.id}/notes`, {
    method: "POST",
    body: JSON.stringify({
      note: "Analytics stats resynced after an HPOS migration mismatch. " +
            "Order data was untouched; only the stats lookup row was rebuilt.",
    }),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run() {
  let resynced = 0;
  let checked = 0;
  for await (const order of listOrders(LOOKBACK_DAYS)) {
    checked++;
    const reportRow = await getReportRow(order.id);
    const [action, reason] = decide(order, reportRow);
    if (action === "skip" || action === "ok") continue;
    console.log(`Order ${order.id}: ${reason}. ${DRY_RUN ? "would resync" : "resyncing"}`);
    if (!DRY_RUN) {
      await touchOrder(order);
      await sleep(200); // be gentle with wp-cron and the stats rebuild queue
    }
    resynced++;
  }
  console.log(`Done. Checked ${checked} order(s). ${resynced} ${DRY_RUN ? "to resync" : "resynced"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
