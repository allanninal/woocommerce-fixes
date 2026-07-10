import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./find-orphaned-subscriptions.js";

const subscription = (over = {}) => ({ id: 501, status: "active", customer_id: 42, ...over });

test("ok when customer_id set and user exists", () => {
  assert.equal(decide(subscription(), true, null)[0], "ok");
});

test("reattach when customer_id is zero but stripe names an owner", () => {
  assert.equal(decide(subscription({ customer_id: 0 }), false, 77)[0], "reattach");
});

test("reattach when customer_id points at a deleted user", () => {
  assert.equal(decide(subscription({ customer_id: 42 }), false, 77)[0], "reattach");
});

test("orphan when no customer and no stripe owner", () => {
  assert.equal(decide(subscription({ customer_id: 0 }), false, null)[0], "orphan");
});

test("skip when status is cancelled", () => {
  assert.equal(decide(subscription({ status: "cancelled", customer_id: 0 }), false, null)[0], "skip");
});

test("skip when status is pending", () => {
  assert.equal(decide(subscription({ status: "pending", customer_id: 0 }), false, null)[0], "skip");
});

test("ok takes priority even with a stray stripe owner present", () => {
  assert.equal(decide(subscription(), true, 99)[0], "ok");
});

test("intentIdOf from meta", () => {
  assert.equal(
    intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }),
    "pi_123"
  );
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});
