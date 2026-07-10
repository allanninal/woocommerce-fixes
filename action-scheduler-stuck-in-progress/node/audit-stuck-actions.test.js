import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./audit-stuck-actions.js";

const action = (over = {}) => ({ status: "in-progress", ageMinutes: 55, actionId: 1, ...over });
const order = (over = {}) => ({ status: "pending", total: "50.00", ...over });
const intent = (over = {}) => ({ status: "succeeded", id: "pi_1", ...over });

test("skip when action not in-progress", () => {
  assert.equal(decide(action({ status: "complete" }), order(), intent())[0], "skip");
});

test("wait when not stuck long enough", () => {
  assert.equal(decide(action({ ageMinutes: 5 }), order(), intent())[0], "wait");
});

test("investigate when order missing", () => {
  assert.equal(decide(action(), null, null)[0], "investigate");
});

test("investigate when payment in flight", () => {
  assert.equal(decide(action(), order(), intent({ status: "requires_action" }))[0], "investigate");
});

test("reset_action when order already paid", () => {
  assert.equal(decide(action(), order({ status: "processing" }), intent())[0], "reset_action");
});

test("complete_order when Stripe succeeded but order unpaid", () => {
  const [verdict] = decide(action(), order({ status: "pending" }), intent({ status: "succeeded" }));
  assert.equal(verdict, "complete_order");
});

test("reset_action when no intent at all", () => {
  assert.equal(decide(action(), order(), null)[0], "reset_action");
});

test("reset_action when intent failed", () => {
  assert.equal(decide(action(), order(), intent({ status: "requires_payment_method" }))[0], "reset_action");
});

test("reset_action when intent canceled", () => {
  assert.equal(decide(action(), order(), intent({ status: "canceled" }))[0], "reset_action");
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
