import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, orderAmountMinor } from "./repair-transient-residue.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, id: "pi_1", ...over });

test("repair when succeeded but order left unpaid", () => {
  assert.equal(decide({ status: "pending", total: "50.00" }, intent())[0], "repair");
});

test("skip when succeeded and already processing", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent())[0], "skip");
});

test("skip when amount mismatch needs a human", () => {
  assert.equal(decide({ status: "pending", total: "40.00" }, intent())[0], "skip");
});

test("repair when canceled but order left processing", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent({ status: "canceled" }))[0], "repair");
});

test("skip when canceled and order already on-hold", () => {
  assert.equal(decide({ status: "on-hold", total: "50.00" }, intent({ status: "canceled" }))[0], "skip");
});

test("skip when intent still in progress", () => {
  assert.equal(decide({ status: "pending", total: "50.00" }, intent({ status: "requires_action" }))[0], "skip");
});

test("orphan when no intent id", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, null)[0], "orphan");
});

test("skip when order status is not tracked", () => {
  assert.equal(decide({ status: "cancelled", total: "50.00" }, intent({ status: "canceled" }))[0], "skip");
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

test("orderAmountMinor converts dollars to cents", () => {
  assert.equal(orderAmountMinor({ total: "19.99" }), 1999);
});
