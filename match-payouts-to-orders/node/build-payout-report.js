/**
 * Build a per payout report that ties a Stripe payout to the WooCommerce orders behind it.
 *
 * A bank deposit is never the sum of the order totals you see in WooCommerce. Stripe groups
 * many charges, refunds, and fees into one payout, converts everything to minor units, and
 * settles a few days after the charge. Nothing in WooCommerce shows you that grouping. This
 * script reads one payout's balance transactions from Stripe, matches each charge to its
 * WooCommerce order by the saved PaymentIntent id, and builds a line by line report where the
 * payout total, the sum of the matched order net amounts, and Stripe's own totals all agree to
 * the cent. Any line that cannot be matched, or any payout that does not tie out, is flagged
 * for a person to look at. Read only by default. Run once per payout, or on a schedule shortly
 * after each payout lands.
 *
 * Guide: https://www.allanninal.dev/woocommerce/match-payouts-to-orders/
 */
import Stripe from "stripe";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");
const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const TIE_OUT_TOLERANCE_MINOR = Number(process.env.TIE_OUT_TOLERANCE_MINOR || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Balance transaction types that represent a customer charge landing in the payout.
const CHARGE_TYPES = new Set(["charge", "payment"]);

export function sourceIntentId(balanceTxn) {
  const source = balanceTxn.source;
  if (source && typeof source === "object") return source.payment_intent || null;
  return null;
}

export function intentIdOf(order) {
  for (const meta of order.meta_data || []) {
    if (meta.key === "_stripe_intent_id" && meta.value) return meta.value;
  }
  const tid = order.transaction_id;
  return tid && tid.startsWith("pi_") ? tid : null;
}

export function orderAmountMinor(order) {
  // Works for two decimal currencies. Zero decimal currencies (JPY and friends)
  // have their own guide, since Math.round(x * 100) is wrong for those.
  return Math.round(parseFloat(order.total) * 100);
}

/**
 * Pure decision: given one balance transaction from a payout and the WooCommerce order
 * it points to (or null), classify the line for the report. No I/O here, so this is
 * fully unit testable.
 */
export function lineFor(balanceTxn, order) {
  const netMinor = balanceTxn.net ?? 0;
  const txnType = balanceTxn.type;
  const intentId = sourceIntentId(balanceTxn);

  const row = {
    balanceTransactionId: balanceTxn.id,
    type: txnType,
    netMinor,
    intentId,
    orderId: order ? order.id : null,
  };

  if (!CHARGE_TYPES.has(txnType)) {
    row.status = "not_a_charge";
    row.note = `'${txnType}' line, included in the payout total but has no single order to match`;
    return row;
  }

  if (!intentId) {
    row.status = "unmatched";
    row.note = "no PaymentIntent on this balance transaction";
    return row;
  }

  if (!order) {
    row.status = "orphan";
    row.note = `no WooCommerce order has PaymentIntent ${intentId} on record`;
    return row;
  }

  const orderMinor = orderAmountMinor(order);
  const drift = orderMinor - netMinor;
  if (Math.abs(drift) <= TIE_OUT_TOLERANCE_MINOR) {
    row.status = "matched";
    row.note = "order total matches the net amount in the payout";
  } else {
    row.status = "mismatch";
    row.note = `order total and payout net disagree by ${drift} minor units`;
  }
  return row;
}

/** Pure roll up: does the report tie out to the cent for this payout. */
export function summarize(payout, rows) {
  const matchedNet = rows
    .filter((r) => r.status === "matched" || r.status === "mismatch")
    .reduce((sum, r) => sum + r.netMinor, 0);
  const otherNet = rows
    .filter((r) => r.status === "not_a_charge")
    .reduce((sum, r) => sum + r.netMinor, 0);
  const accountedMinor = matchedNet + otherNet;
  const payoutMinor = payout.amount ?? 0;
  const drift = payoutMinor - accountedMinor;
  const tiesOut = Math.abs(drift) <= TIE_OUT_TOLERANCE_MINOR;
  const unmatchedCount = rows.filter((r) =>
    r.status === "unmatched" || r.status === "orphan" || r.status === "mismatch"
  ).length;
  return {
    payoutId: payout.id,
    payoutAmountMinor: payoutMinor,
    accountedMinor,
    driftMinor: drift,
    tiesOut,
    unmatchedCount,
  };
}

async function* listPayoutTransactions(payoutId) {
  for await (const txn of stripe.balanceTransactions.list({ payout: payoutId, limit: 100 })) {
    yield txn;
  }
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function getOrderByIntent(intentId) {
  if (!intentId) return null;
  const matches = await woo(`/orders?search=${encodeURIComponent(intentId)}&per_page=5`);
  for (const order of matches) {
    if (intentIdOf(order) === intentId) return order;
  }
  return null;
}

async function writeNote(orderId, note) {
  await woo(`/orders/${orderId}/notes`, { method: "POST", body: JSON.stringify({ note }) });
}

export async function buildReport(payoutId) {
  const payout = await stripe.payouts.retrieve(payoutId);
  const rows = [];
  for await (const txn of listPayoutTransactions(payoutId)) {
    const intentId = sourceIntentId(txn);
    const order = intentId ? await getOrderByIntent(intentId) : null;
    rows.push(lineFor(txn, order));
  }
  const summary = summarize(payout, rows);
  return { summary, rows };
}

export function toCsv(summary, rows) {
  const lines = [
    `payout_id,${summary.payoutId}`,
    `payout_amount_minor,${summary.payoutAmountMinor}`,
    `accounted_minor,${summary.accountedMinor}`,
    `drift_minor,${summary.driftMinor}`,
    `ties_out,${summary.tiesOut}`,
    "",
    "balance_transaction_id,type,net_minor,intent_id,order_id,status,note",
  ];
  for (const r of rows) {
    lines.push([r.balanceTransactionId, r.type, r.netMinor, r.intentId, r.orderId, r.status, r.note].join(","));
  }
  return lines.join("\n");
}

export async function run(payoutId) {
  const { summary, rows } = await buildReport(payoutId);
  console.log(
    `Payout ${summary.payoutId}: amount ${summary.payoutAmountMinor}, accounted ${summary.accountedMinor}, ` +
    `drift ${summary.driftMinor}, ties out: ${summary.tiesOut}, ${summary.unmatchedCount} line(s) need review`
  );
  const report = toCsv(summary, rows);
  if (DRY_RUN) {
    console.log(`Dry run, report generated but not written or annotated:\n${report}`);
    return { summary, rows };
  }
  const outPath = `payout-${summary.payoutId}.csv`;
  await writeFile(outPath, report);
  console.log(`Report written to ${outPath}`);
  for (const row of rows) {
    if (row.status === "mismatch" && row.orderId) {
      await writeNote(
        row.orderId,
        `Payout reconciliation: order net does not match payout ${summary.payoutId} ` +
        `(drift ${row.netMinor} vs order total). Please review.`
      );
    }
  }
  return { summary, rows };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const payoutId = process.env.PAYOUT_ID;
  if (!payoutId) {
    console.error("Set PAYOUT_ID to the po_... id you want to reconcile.");
    process.exit(1);
  }
  run(payoutId).catch((e) => { console.error(e); process.exit(1); });
}
