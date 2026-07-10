import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./card-check-auditor.js";

const intent = (over = {}) => ({ id: "pi_1", amount: 0, status: "requires_payment_method", ...over });

test("restore when intent amount is zero", () => {
  assert.equal(decide({ status: "on-hold" }, intent())[0], "restore");
});

test("skip when subscription not dunned", () => {
  assert.equal(decide({ status: "active" }, intent())[0], "skip");
});

test("skip when no intent to check", () => {
  assert.equal(decide({ status: "on-hold" }, null)[0], "skip");
});

test("skip when real charge declined", () => {
  assert.equal(decide({ status: "on-hold" }, intent({ amount: 2900, status: "requires_payment_method" }))[0], "skip");
});

test("skip when intent actually succeeded", () => {
  assert.equal(decide({ status: "pending-cancel" }, intent({ amount: 2900, status: "succeeded" }))[0], "skip");
});

test("restore applies to pending-cancel too", () => {
  assert.equal(decide({ status: "pending-cancel" }, intent())[0], "restore");
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
