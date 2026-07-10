import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./attach-off-session-mandate.js";

const subscription = (over = {}) => ({ id: 501, status: "active", ...over });
const paymentMethod = (over = {}) => ({ id: "pm_1", type: "card", customer: "cus_1", off_session_mandate: null, ...over });

test("attach_mandate when card has none", () => {
  assert.equal(decide(subscription(), paymentMethod())[0], "attach_mandate");
});

test("ok when mandate already exists", () => {
  const pm = paymentMethod({ off_session_mandate: "seti_123" });
  assert.equal(decide(subscription(), pm)[0], "ok");
});

test("no_payment_method when none saved", () => {
  assert.equal(decide(subscription(), null)[0], "no_payment_method");
});

test("skip when subscription not active", () => {
  const sub = subscription({ status: "cancelled" });
  assert.equal(decide(sub, paymentMethod())[0], "skip");
});

test("attach_mandate for on-hold subscription", () => {
  const sub = subscription({ status: "on-hold" });
  assert.equal(decide(sub, paymentMethod())[0], "attach_mandate");
});

test("skip for unsupported payment method type", () => {
  const pm = paymentMethod({ type: "alipay" });
  assert.equal(decide(subscription(), pm)[0], "skip");
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
