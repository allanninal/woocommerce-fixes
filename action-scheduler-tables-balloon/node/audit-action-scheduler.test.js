import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./audit-action-scheduler.js";

const group = (over = {}) => ({ status: "complete", ageDays: 45, rowCount: 1, ...over });
const order = (over = {}) => ({ status: "completed", ...over });
const intent = (over = {}) => ({ status: "succeeded", ...over });

test("keep when action still pending", () => {
  assert.equal(decide(group({ status: "pending" }), order(), intent())[0], "keep");
});

test("keep when younger than retention window", () => {
  assert.equal(decide(group({ ageDays: 5 }), order(), intent())[0], "keep");
});

test("purge when no matching order", () => {
  assert.equal(decide(group(), null, null)[0], "purge");
});

test("warn when order still open", () => {
  assert.equal(decide(group(), order({ status: "processing" }), intent())[0], "warn");
});

test("purge when order closed and no stripe intent", () => {
  assert.equal(decide(group(), order({ status: "cancelled" }), null)[0], "purge");
});

test("warn when intent not closed", () => {
  assert.equal(decide(group(), order(), intent({ status: "requires_payment_method" }))[0], "warn");
});

test("purge when order closed and intent succeeded", () => {
  assert.equal(decide(group(), order(), intent({ status: "succeeded" }))[0], "purge");
});

test("purge when intent canceled counts as closed", () => {
  assert.equal(decide(group(), order(), intent({ status: "canceled" }))[0], "purge");
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
