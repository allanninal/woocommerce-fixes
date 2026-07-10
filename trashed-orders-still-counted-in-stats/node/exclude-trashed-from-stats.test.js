import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, isExcluded } from "./exclude-trashed-from-stats.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, amount_refunded: 0, ...over });

test("skip when not trashed", () => {
  assert.equal(decide({ status: "processing" }, intent())[0], "skip");
});

test("skip when already excluded", () => {
  const order = { status: "trash", meta_data: [{ key: "_exclude_from_stats", value: "yes" }] };
  assert.equal(decide(order, intent())[0], "skip");
});

test("repair when no intent", () => {
  const order = { status: "trash", meta_data: [] };
  assert.equal(decide(order, null)[0], "repair");
});

test("repair when intent not succeeded", () => {
  const order = { status: "trash", meta_data: [] };
  assert.equal(decide(order, intent({ status: "requires_payment_method" }))[0], "repair");
});

test("repair when fully refunded", () => {
  const order = { status: "trash", meta_data: [] };
  assert.equal(decide(order, intent({ amount_refunded: 5000 }))[0], "repair");
});

test("hold when charge is live and unrefunded", () => {
  const order = { status: "trash", meta_data: [] };
  assert.equal(decide(order, intent())[0], "hold");
});

test("isExcluded true variants", () => {
  assert.equal(isExcluded({ meta_data: [{ key: "_exclude_from_stats", value: "1" }] }), true);
  assert.equal(isExcluded({ meta_data: [{ key: "_exclude_from_stats", value: "yes" }] }), true);
});

test("isExcluded false when absent", () => {
  assert.equal(isExcluded({ meta_data: [] }), false);
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
