import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, lockValueOf, transientKeyFor } from "./clear-stale-checkout-locks.js";

const intent = (over = {}) => ({ status: "succeeded", id: "pi_1", ...over });

test("clear when lock present and intent settled", () => {
  const order = { meta_data: [{ key: "_stripe_checkout_lock", value: "1" }] };
  assert.equal(decide(order, intent())[0], "clear");
});

test("clear when intent canceled", () => {
  const order = { meta_data: [{ key: "_stripe_checkout_lock", value: "1" }] };
  assert.equal(decide(order, intent({ status: "canceled" }))[0], "clear");
});

test("skip when no lock", () => {
  const order = { meta_data: [] };
  assert.equal(decide(order, intent())[0], "skip");
});

test("skip when no intent", () => {
  const order = { meta_data: [{ key: "_stripe_checkout_lock", value: "1" }] };
  assert.equal(decide(order, null)[0], "skip");
});

test("skip when intent still in progress", () => {
  const order = { meta_data: [{ key: "_stripe_checkout_lock", value: "1" }] };
  assert.equal(decide(order, intent({ status: "requires_action" }))[0], "skip");
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

test("lockValueOf present", () => {
  assert.equal(lockValueOf({ meta_data: [{ key: "_stripe_checkout_lock", value: "1" }] }), "1");
});

test("lockValueOf missing", () => {
  assert.equal(lockValueOf({ meta_data: [] }), null);
});

test("transientKeyFor", () => {
  assert.equal(transientKeyFor("pi_123"), "_transient_wc_stripe_lock_pi_123");
});
