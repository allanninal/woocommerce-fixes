import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./find-orphaned-postmeta.js";

const intent = (over = {}) => ({ id: "pi_1", metadata: { order_id: "501" }, ...over });

test("orphan when order missing", () => {
  assert.equal(decide(null, intent())[0], "orphan");
});

test("ok when order still exists", () => {
  assert.equal(decide({ id: 501 }, intent())[0], "ok");
});

test("skip when no intent", () => {
  assert.equal(decide({ id: 501 }, null)[0], "skip");
});

test("skip when intent has no order_id", () => {
  assert.equal(decide(null, intent({ metadata: {} }))[0], "skip");
});

test("skip when order id mismatch", () => {
  assert.equal(decide({ id: 999 }, intent())[0], "skip");
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
