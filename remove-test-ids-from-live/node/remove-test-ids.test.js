import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./remove-test-ids.js";

test("clear when id missing on live", () => {
  assert.equal(decide({ status: "processing" }, "pi_test_123", null)[0], "clear");
});

test("ok when id resolves", () => {
  assert.equal(decide({ status: "processing" }, "pi_live_123", { id: "pi_live_123" })[0], "ok");
});

test("skip when no id saved", () => {
  assert.equal(decide({ status: "processing" }, null, null)[0], "skip");
});

test("skip when order not in paid state", () => {
  assert.equal(decide({ status: "pending" }, "pi_test_123", null)[0], "skip");
});

test("clear when on-hold and missing", () => {
  assert.equal(decide({ status: "on-hold" }, "pi_test_999", null)[0], "clear");
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
