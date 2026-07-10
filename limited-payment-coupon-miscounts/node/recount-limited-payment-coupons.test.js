import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  storedCounter,
  orderAppliedCoupon,
  truePaymentCount,
  intentIdOf,
} from "./recount-limited-payment-coupons.js";

const subscription = (counter = null, code = "vip10") => {
  const meta = [];
  if (counter !== null) meta.push({ key: `_coupon_number_payments_${code.toLowerCase()}`, value: String(counter) });
  return { id: 42, meta_data: meta };
};

const order = (status = "processing", code = "vip10", intentId = "pi_1") => {
  const o = { status, coupon_lines: [{ code }] };
  if (intentId !== null) o.meta_data = [{ key: "_stripe_intent_id", value: intentId }];
  return o;
};

test("storedCounter reads the right meta key", () => {
  assert.equal(storedCounter(subscription(3), "VIP10"), 3);
});

test("storedCounter is null when missing", () => {
  assert.equal(storedCounter(subscription(null), "vip10"), null);
});

test("orderAppliedCoupon is case insensitive", () => {
  assert.equal(orderAppliedCoupon(order("processing", "VIP10"), "vip10"), true);
  assert.equal(orderAppliedCoupon(order("processing", "other"), "vip10"), false);
});

test("truePaymentCount only counts paid orders with the coupon", () => {
  const orders = [
    order("processing", "vip10", "pi_1"),
    order("pending", "vip10", "pi_2"),
    order("processing", "other", "pi_3"),
  ];
  const verified = new Set(["pi_1", "pi_2", "pi_3"]);
  assert.equal(truePaymentCount(orders, "vip10", verified), 1);
});

test("truePaymentCount skips orders Stripe does not confirm", () => {
  const orders = [order("processing", "vip10", "pi_1"), order("processing", "vip10", "pi_2")];
  const verified = new Set(["pi_1"]);
  assert.equal(truePaymentCount(orders, "vip10", verified), 1);
});

test("decide skip when counter matches", () => {
  assert.equal(decide(subscription(2), "vip10", 2)[0], "skip");
});

test("decide repair when counter is ahead", () => {
  const [action, reason] = decide(subscription(5), "vip10", 2);
  assert.equal(action, "repair");
  assert.match(reason, /ahead of/);
});

test("decide repair when counter is behind", () => {
  const [action, reason] = decide(subscription(1), "vip10", 3);
  assert.equal(action, "repair");
  assert.match(reason, /behind/);
});

test("decide unknown when no counter stored", () => {
  assert.equal(decide(subscription(null), "vip10", 2)[0], "unknown");
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
