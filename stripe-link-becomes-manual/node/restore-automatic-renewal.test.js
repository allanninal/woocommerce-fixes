import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isReusable, intentIdOf } from "./restore-automatic-renewal.js";

const pm = (over = {}) => ({ type: "card", ...over });

test("repair when manual and reusable method found", () => {
  assert.equal(decide({ requires_manual_renewal: true, payment_method: "stripe" }, pm())[0], "repair");
});

test("repair allows bank account and sepa too", () => {
  const sub = { requires_manual_renewal: true, payment_method: "stripe" };
  assert.equal(decide(sub, pm({ type: "us_bank_account" }))[0], "repair");
  assert.equal(decide(sub, pm({ type: "sepa_debit" }))[0], "repair");
});

test("skip when already automatic", () => {
  assert.equal(decide({ requires_manual_renewal: false, payment_method: "stripe" }, pm())[0], "skip");
});

test("skip when not stripe gateway", () => {
  assert.equal(decide({ requires_manual_renewal: true, payment_method: "cheque" }, pm())[0], "skip");
});

test("keep manual when no payment method", () => {
  assert.equal(decide({ requires_manual_renewal: true, payment_method: "stripe" }, null)[0], "keep_manual");
});

test("keep manual when payment method is not a reusable type", () => {
  const sub = { requires_manual_renewal: true, payment_method: "stripe" };
  assert.equal(decide(sub, pm({ type: "link" }))[0], "keep_manual");
});

test("isReusable false for null", () => {
  assert.equal(isReusable(null), false);
});

test("isReusable true for card", () => {
  assert.equal(isReusable(pm({ type: "card" })), true);
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
