import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, orderCustomerKey } from "./release-failed-coupons.js";

const intent = (over = {}) => ({ status: "requires_payment_method", ...over });
const coupon = (over = {}) => ({ used_by: ["shopper@example.com"], usage_count: 1, ...over });
const order = (over = {}) => ({
  status: "failed",
  billing: { email: "shopper@example.com" },
  customer_id: 0,
  ...over,
});

test("release when failed and intent not succeeded", () => {
  assert.equal(decide(order(), intent(), coupon())[0], "release");
});

test("release when no intent at all", () => {
  assert.equal(decide(order(), null, coupon())[0], "release");
});

test("skip when order not failed or cancelled", () => {
  assert.equal(decide(order({ status: "processing" }), intent(), coupon())[0], "skip");
});

test("skip when Stripe actually succeeded", () => {
  assert.equal(decide(order(), intent({ status: "succeeded" }), coupon())[0], "skip");
});

test("skip when already released", () => {
  assert.equal(decide(order(), intent(), coupon({ used_by: [] }))[0], "skip");
});

test("skip when no identity to match", () => {
  const o = order({ billing: { email: "" }, customer_id: 0 });
  assert.equal(decide(o, intent(), coupon())[0], "skip");
});

test("cancelled order also eligible", () => {
  assert.equal(decide(order({ status: "cancelled" }), intent(), coupon())[0], "release");
});

test("intentIdOf from meta", () => {
  const o = { meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" };
  assert.equal(intentIdOf(o), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("orderCustomerKey prefers email", () => {
  assert.equal(orderCustomerKey({ billing: { email: "a@b.com" }, customer_id: 7 }), "a@b.com");
});

test("orderCustomerKey falls back to customer_id", () => {
  assert.equal(orderCustomerKey({ billing: { email: "" }, customer_id: 7 }), "7");
});

test("orderCustomerKey null when no identity", () => {
  assert.equal(orderCustomerKey({ billing: { email: "" }, customer_id: 0 }), null);
});
