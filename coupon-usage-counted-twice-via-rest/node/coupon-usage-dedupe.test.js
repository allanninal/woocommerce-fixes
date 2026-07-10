import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, countsAsOneRealUse, intentIdOf } from "./coupon-usage-dedupe.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });
const coupon = (over = {}) => ({ id: 42, code: "SAVE10", usage_count: 2, ...over });
const order = (over = {}) => ({ id: 900, status: "processing", total: "50.00", ...over });

// decide()

test("fix when usage_count is inflated", () => {
  const [action, , corrected] = decide(coupon({ usage_count: 2 }), 1);
  assert.equal(action, "fix");
  assert.equal(corrected, 1);
});

test("skip when usage_count matches verified orders", () => {
  const [action] = decide(coupon({ usage_count: 1 }), 1);
  assert.equal(action, "skip");
});

test("skip when verified count exceeds usage_count (undercount, different bug)", () => {
  const [action] = decide(coupon({ usage_count: 1 }), 2);
  assert.equal(action, "skip");
});

test("skip when usage_count already negative", () => {
  const [action] = decide(coupon({ usage_count: -1 }), 0);
  assert.equal(action, "skip");
});

test("fix reason mentions both numbers", () => {
  const [, reason] = decide(coupon({ usage_count: 3 }), 1);
  assert.match(reason, /3/);
  assert.match(reason, /1/);
});

// countsAsOneRealUse()

test("counts when status valid and stripe confirms paid", () => {
  assert.equal(countsAsOneRealUse(order(), intent()), true);
});

test("does not count when order status not valid", () => {
  assert.equal(countsAsOneRealUse(order({ status: "pending" }), intent()), false);
});

test("does not count when intent missing", () => {
  assert.equal(countsAsOneRealUse(order(), null), false);
});

test("does not count when intent not succeeded", () => {
  assert.equal(countsAsOneRealUse(order(), intent({ status: "requires_payment_method" })), false);
});

test("does not count when amount mismatches", () => {
  assert.equal(countsAsOneRealUse(order({ total: "50.00" }), intent({ amount_received: 1000 })), false);
});

test("counts with on-hold status", () => {
  assert.equal(countsAsOneRealUse(order({ status: "on-hold" }), intent()), true);
});

// intentIdOf()

test("intentIdOf from meta", () => {
  const o = { meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" };
  assert.equal(intentIdOf(o), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  const o = { meta_data: [], transaction_id: "pi_456" };
  assert.equal(intentIdOf(o), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  const o = { meta_data: [], transaction_id: "ch_789" };
  assert.equal(intentIdOf(o), null);
});
