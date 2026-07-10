import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, hasSettlementRecorded } from "./record-settlement-currency.js";

const balanceTransaction = (over = {}) => ({ amount: 4520, currency: "usd", exchange_rate: 0.904, ...over });
const order = (over = {}) => ({ status: "processing", total: "50.00", currency: "eur", meta_data: [], ...over });

test("record when currencies differ and rate present", () => {
  assert.equal(decide(order(), balanceTransaction())[0], "record");
});

test("skip when order not paid", () => {
  assert.equal(decide(order({ status: "pending" }), balanceTransaction())[0], "skip");
});

test("skip when already recorded", () => {
  const o = order({ meta_data: [{ key: "_stripe_settlement_amount", value: 4520 }] });
  assert.equal(decide(o, balanceTransaction())[0], "skip");
});

test("orphan when no balance transaction", () => {
  assert.equal(decide(order(), null)[0], "orphan");
});

test("same-currency when presentment matches settlement", () => {
  const o = order({ currency: "usd" });
  const bt = balanceTransaction({ currency: "usd", exchange_rate: null });
  assert.equal(decide(o, bt)[0], "same-currency");
});

test("same-currency is case insensitive", () => {
  const o = order({ currency: "USD" });
  const bt = balanceTransaction({ currency: "usd", exchange_rate: null });
  assert.equal(decide(o, bt)[0], "same-currency");
});

test("mismatch when currencies differ but no exchange rate", () => {
  const o = order({ currency: "eur" });
  const bt = balanceTransaction({ currency: "usd", exchange_rate: null });
  assert.equal(decide(o, bt)[0], "mismatch");
});

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("hasSettlementRecorded true", () => {
  assert.equal(hasSettlementRecorded({ meta_data: [{ key: "_stripe_settlement_amount", value: 100 }] }), true);
});

test("hasSettlementRecorded false", () => {
  assert.equal(hasSettlementRecorded({ meta_data: [] }), false);
});
