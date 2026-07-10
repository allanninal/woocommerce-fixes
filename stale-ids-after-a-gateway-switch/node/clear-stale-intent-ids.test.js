import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./clear-stale-intent-ids.js";

test("clear when id not found and order finished", () => {
  assert.equal(decide({ status: "processing" }, "not_found")[0], "clear");
});

test("skip when id resolves", () => {
  assert.equal(decide({ status: "completed" }, "resolved")[0], "skip");
});

test("skip when no id saved", () => {
  assert.equal(decide({ status: "processing" }, "no_id")[0], "skip");
});

test("skip when order not finished even if stale", () => {
  assert.equal(decide({ status: "pending" }, "not_found")[0], "skip");
});

test("skip on-hold order with resolved id", () => {
  assert.equal(decide({ status: "on-hold" }, "resolved")[0], "skip");
});

test("clear on refunded order with stale id", () => {
  assert.equal(decide({ status: "refunded" }, "not_found")[0], "clear");
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

test("intentIdOf null when nothing saved", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "" }), null);
});
