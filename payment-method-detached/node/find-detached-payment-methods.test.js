import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./find-detached-payment-methods.js";

const subscription = (over = {}) => ({ id: 501, status: "active", stripe_customer_id: "cus_1", ...over });
const renewalOrder = (over = {}) => ({
  meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }],
  transaction_id: "",
  ...over,
});
const paymentMethod = (over = {}) => ({ id: "pm_1", customer: "cus_1", ...over });

test("ok when attached to expected customer", () => {
  assert.equal(decide(subscription(), renewalOrder(), paymentMethod())[0], "ok");
});

test("flag when payment method missing", () => {
  assert.equal(decide(subscription(), renewalOrder(), null)[0], "flag");
});

test("flag when payment method detached", () => {
  const pm = paymentMethod({ customer: null });
  assert.equal(decide(subscription(), renewalOrder(), pm)[0], "flag");
});

test("flag when attached to a different customer", () => {
  const pm = paymentMethod({ customer: "cus_999" });
  assert.equal(decide(subscription(), renewalOrder(), pm)[0], "flag");
});

test("skip when subscription not active", () => {
  const sub = subscription({ status: "cancelled" });
  assert.equal(decide(sub, renewalOrder(), paymentMethod())[0], "skip");
});

test("skip when no renewal order yet", () => {
  assert.equal(decide(subscription(), null, paymentMethod())[0], "skip");
});

test("skip when renewal order has no intent id", () => {
  const order = renewalOrder({ meta_data: [], transaction_id: "" });
  assert.equal(decide(subscription(), order, paymentMethod())[0], "skip");
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
