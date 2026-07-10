import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, beforeCodesOf, recurringCouponCodes, intentIdOf } from "./reapply-switch-coupon.js";

const intent = (over = {}) => ({ status: "succeeded", id: "pi_1", ...over });

test("reapply when coupon dropped and switch succeeded", () => {
  const [action, , dropped] = decide(["vip10"], [], intent());
  assert.equal(action, "reapply");
  assert.deepEqual(dropped, ["vip10"]);
});

test("skip when no coupon was dropped", () => {
  const [action, , dropped] = decide(["vip10"], ["vip10"], intent());
  assert.equal(action, "skip");
  assert.deepEqual(dropped, []);
});

test("skip when no Stripe payment found", () => {
  const [action] = decide(["vip10"], [], null);
  assert.equal(action, "skip");
});

test("skip when switch payment did not succeed", () => {
  const [action] = decide(["vip10"], [], intent({ status: "requires_action" }));
  assert.equal(action, "skip");
});

test("multiple dropped coupons are all reported", () => {
  const [action, , dropped] = decide(["vip10", "loyalty5"], [], intent());
  assert.equal(action, "reapply");
  assert.deepEqual(dropped, ["loyalty5", "vip10"]);
});

test("beforeCodesOf reads switch meta", () => {
  const order = { meta_data: [{ key: "_switch_recurring_coupons", value: ["vip10"] }] };
  assert.deepEqual(beforeCodesOf(order), ["vip10"]);
});

test("beforeCodesOf empty when missing", () => {
  assert.deepEqual(beforeCodesOf({ meta_data: [] }), []);
});

test("recurringCouponCodes reads subscription coupon_lines", () => {
  const subscription = { coupon_lines: [{ code: "vip10" }, { code: "loyalty5" }] };
  assert.deepEqual(recurringCouponCodes(subscription), ["loyalty5", "vip10"]);
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
