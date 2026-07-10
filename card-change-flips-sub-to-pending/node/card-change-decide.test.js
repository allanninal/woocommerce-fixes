import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, currentCardToken, getMeta } from "./resume-pending-after-card-change.js";

const intent = (over = {}) => ({ status: "succeeded", payment_method: "pm_new", ...over });

test("resume when succeeded and card matches", () => {
  assert.equal(decide("pending", intent(), "pm_new")[0], "resume");
});

test("wait when no intent yet", () => {
  assert.equal(decide("pending", null, "pm_new")[0], "wait");
});

test("wait when intent not succeeded", () => {
  assert.equal(decide("pending", intent({ status: "requires_action" }), "pm_new")[0], "wait");
});

test("mismatch when card differs", () => {
  assert.equal(decide("pending", intent(), "pm_old")[0], "mismatch");
});

test("mismatch when no card to compare", () => {
  assert.equal(decide("pending", intent(), null)[0], "mismatch");
});

test("skip when not pending", () => {
  assert.equal(decide("active", intent(), "pm_new")[0], "skip");
});

test("skip takes priority over missing intent", () => {
  assert.equal(decide("on-hold", null, "pm_new")[0], "skip");
});

test("intentIdOf from meta", () => {
  const sub = { meta_data: [{ key: "_stripe_intent_id", value: "seti_123" }], transaction_id: "" };
  assert.equal(intentIdOf(sub), "seti_123");
});

test("intentIdOf falls back to transaction_id", () => {
  const sub = { meta_data: [], transaction_id: "seti_456" };
  assert.equal(intentIdOf(sub), "seti_456");
});

test("intentIdOf null when transaction is not a setup intent", () => {
  const sub = { meta_data: [], transaction_id: "pi_789" };
  assert.equal(intentIdOf(sub), null);
});

test("currentCardToken prefers source id", () => {
  const sub = { meta_data: [
    { key: "_stripe_source_id", value: "pm_source" },
    { key: "_payment_method_token", value: "pm_token" },
  ] };
  assert.equal(currentCardToken(sub), "pm_source");
});

test("currentCardToken falls back to payment_method_token", () => {
  const sub = { meta_data: [{ key: "_payment_method_token", value: "pm_token" }] };
  assert.equal(currentCardToken(sub), "pm_token");
});

test("getMeta missing key returns null", () => {
  assert.equal(getMeta({ meta_data: [] }, "_stripe_intent_id"), null);
});
