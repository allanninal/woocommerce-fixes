import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, orderAmountMinor, capturedAmountMinor } from "./check-amount-mismatch.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });

test("ok when amounts match", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent())[0], "ok");
});

test("flag when order total higher than charge", () => {
  const [action, reason] = decide({ status: "processing", total: "55.00" }, intent());
  assert.equal(action, "flag");
  assert.match(reason, /higher/);
});

test("flag when order total lower than charge", () => {
  const [action, reason] = decide({ status: "completed", total: "45.00" }, intent());
  assert.equal(action, "flag");
  assert.match(reason, /lower/);
});

test("skip when order not paid", () => {
  assert.equal(decide({ status: "pending", total: "50.00" }, intent())[0], "skip");
});

test("skip when no intent", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, null)[0], "skip");
});

test("skip when intent not succeeded", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent({ status: "requires_payment_method" }))[0], "skip");
});

test("tolerance allows rounding of one cent", () => {
  assert.equal(decide({ status: "processing", total: "50.01" }, intent({ amount_received: 5000 }))[0], "ok");
});

test("custom tolerance can be stricter", () => {
  assert.equal(decide({ status: "processing", total: "50.01" }, intent({ amount_received: 5000 }), 0)[0], "flag");
});

test("orderAmountMinor converts dollars to cents", () => {
  assert.equal(orderAmountMinor({ total: "19.99" }), 1999);
});

test("capturedAmountMinor prefers amount_received", () => {
  assert.equal(capturedAmountMinor({ amount_received: 1200, amount: 1500 }), 1200);
});

test("capturedAmountMinor falls back to amount", () => {
  assert.equal(capturedAmountMinor({ amount: 1500 }), 1500);
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
