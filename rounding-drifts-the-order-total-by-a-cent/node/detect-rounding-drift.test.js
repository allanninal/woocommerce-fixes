import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, orderTotalMinor } from "./detect-rounding-drift.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });

test("ok when amounts match exactly", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent())[0], "ok");
});

test("drift when off by one cent (order higher)", () => {
  assert.equal(decide({ status: "processing", total: "50.01" }, intent({ amount_received: 5000 }))[0], "drift");
});

test("drift when off by one cent (order lower)", () => {
  assert.equal(decide({ status: "completed", total: "49.99" }, intent({ amount_received: 5000 }))[0], "drift");
});

test("mismatch when off by more than tolerance", () => {
  assert.equal(decide({ status: "processing", total: "50.10" }, intent({ amount_received: 5000 }))[0], "mismatch");
});

test("orphan when no intent", () => {
  assert.equal(decide({ status: "completed", total: "50.00" }, null)[0], "orphan");
});

test("orphan when intent not succeeded", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent({ status: "requires_payment_method" }))[0], "orphan");
});

test("skip when order not paid", () => {
  assert.equal(decide({ status: "pending", total: "50.00" }, null)[0], "skip");
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

test("orderTotalMinor converts to cents", () => {
  assert.equal(orderTotalMinor({ total: "50.01" }), 5001);
});

test("custom tolerance widens what counts as drift", () => {
  assert.equal(decide({ status: "processing", total: "50.02" }, intent({ amount_received: 5000 }), 2)[0], "drift");
});
