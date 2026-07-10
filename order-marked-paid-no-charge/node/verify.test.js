import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./verify-paid.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });

test("ok when paid and charge matches", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent())[0], "ok");
});

test("flag when no intent", () => {
  assert.equal(decide({ status: "completed", total: "50.00" }, null)[0], "flag");
});

test("flag when intent not succeeded", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent({ status: "requires_payment_method" }))[0], "flag");
});

test("flag when amount mismatch", () => {
  assert.equal(decide({ status: "processing", total: "80.00" }, intent())[0], "flag");
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
