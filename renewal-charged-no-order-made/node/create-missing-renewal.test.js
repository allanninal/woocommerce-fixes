import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, amountMinorFromDecimal, intentIdOf } from "./create-missing-renewal.js";

const intent = (over = {}) => ({ status: "succeeded", id: "pi_1", ...over });

test("create when charged and no order", () => {
  assert.equal(decide({ id: 42, customer_id: 7 }, intent(), false)[0], "create");
});

test("skip when order already exists", () => {
  assert.equal(decide({ id: 42, customer_id: 7 }, intent(), true)[0], "skip");
});

test("skip when intent not succeeded", () => {
  assert.equal(decide({ id: 42, customer_id: 7 }, intent({ status: "requires_payment_method" }), false)[0], "skip");
});

test("orphan when subscription missing", () => {
  assert.equal(decide(null, intent(), false)[0], "orphan");
});

test("skip, not orphan, when subscription missing and intent not succeeded", () => {
  assert.equal(decide(null, intent({ status: "requires_payment_method" }), false)[0], "skip");
});

test("amountMinorFromDecimal converts decimal strings to cents", () => {
  assert.equal(amountMinorFromDecimal("49.99"), 4999);
  assert.equal(amountMinorFromDecimal("10"), 1000);
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
