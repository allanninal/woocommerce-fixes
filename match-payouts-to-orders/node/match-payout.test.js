import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lineFor,
  summarize,
  intentIdOf,
  sourceIntentId,
  orderAmountMinor,
} from "./build-payout-report.js";

const balanceTxn = (over = {}) => ({
  id: "txn_1",
  type: "charge",
  net: 4850,
  source: { payment_intent: "pi_1" },
  ...over,
});

const order = (over = {}) => ({
  id: 501,
  total: "50.00",
  meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }],
  ...over,
});

test("matched when order total equals net", () => {
  const row = lineFor(balanceTxn({ net: 5000 }), order({ total: "50.00" }));
  assert.equal(row.status, "matched");
  assert.equal(row.orderId, 501);
});

test("mismatch when order total disagrees with net", () => {
  const row = lineFor(balanceTxn({ net: 4500 }), order({ total: "50.00" }));
  assert.equal(row.status, "mismatch");
  assert.match(row.note, /disagree/);
});

test("orphan when no order found", () => {
  const row = lineFor(balanceTxn(), null);
  assert.equal(row.status, "orphan");
});

test("unmatched when balance txn has no intent", () => {
  const row = lineFor(balanceTxn({ source: { payment_intent: null } }), null);
  assert.equal(row.status, "unmatched");
});

test("unmatched when source is not an object", () => {
  const row = lineFor(balanceTxn({ source: "ch_no_intent_field" }), null);
  assert.equal(row.status, "unmatched");
});

test("not_a_charge for fee and refund lines", () => {
  assert.equal(lineFor(balanceTxn({ type: "stripe_fee", source: null }), null).status, "not_a_charge");
  assert.equal(lineFor(balanceTxn({ type: "payment_refund", source: null }), null).status, "not_a_charge");
});

test("tolerance allows one cent of rounding", () => {
  const row = lineFor(balanceTxn({ net: 4999 }), order({ total: "50.00" }));
  assert.equal(row.status, "matched");
});

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf(order()), "pi_1");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_999" }), "pi_999");
});

test("intentIdOf null when transaction is a charge id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_999" }), null);
});

test("sourceIntentId reads the nested field", () => {
  assert.equal(sourceIntentId(balanceTxn({ source: { payment_intent: "pi_42" } })), "pi_42");
});

test("orderAmountMinor converts dollars to cents", () => {
  assert.equal(orderAmountMinor({ total: "19.99" }), 1999);
});

test("summarize ties out when charges and fees cover the payout", () => {
  const payout = { id: "po_1", amount: 9700 };
  const rows = [
    lineFor(balanceTxn({ id: "txn_1", net: 5000 }), order({ id: 501, total: "50.00" })),
    lineFor(
      balanceTxn({ id: "txn_2", net: 4700, source: { payment_intent: "pi_2" } }),
      order({ id: 502, total: "47.00", meta_data: [{ key: "_stripe_intent_id", value: "pi_2" }] })
    ),
  ];
  const summary = summarize(payout, rows);
  assert.equal(summary.tiesOut, true);
  assert.equal(summary.driftMinor, 0);
  assert.equal(summary.unmatchedCount, 0);
});

test("summarize flags drift when payout does not tie out", () => {
  const payout = { id: "po_2", amount: 10000 };
  const rows = [lineFor(balanceTxn({ net: 5000 }), order({ total: "50.00" }))];
  const summary = summarize(payout, rows);
  assert.equal(summary.tiesOut, false);
  assert.equal(summary.driftMinor, 5000);
});

test("summarize counts mismatch and orphan as needing review", () => {
  const payout = { id: "po_3", amount: 9500 };
  const rows = [
    lineFor(balanceTxn({ id: "txn_1", net: 5000 }), order({ total: "45.00" })), // mismatch
    lineFor(balanceTxn({ id: "txn_2", net: 4500, source: { payment_intent: "pi_9" } }), null), // orphan
  ];
  const summary = summarize(payout, rows);
  assert.equal(summary.unmatchedCount, 2);
});
