import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, isRenewal, orderAmountMinor } from "./flag-fake-paid-renewals.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 2900, ...over });

test("ok when renewal paid and charge matches", () => {
  assert.equal(decide({ status: "processing", total: "29.00" }, intent())[0], "ok");
});

test("flag when no intent", () => {
  assert.equal(decide({ status: "completed", total: "29.00" }, null)[0], "flag");
});

test("flag when intent not succeeded", () => {
  assert.equal(decide({ status: "processing", total: "29.00" }, intent({ status: "requires_payment_method" }))[0], "flag");
});

test("flag when amount mismatch", () => {
  assert.equal(decide({ status: "processing", total: "49.00" }, intent())[0], "flag");
});

test("skip when renewal not paid", () => {
  assert.equal(decide({ status: "pending", total: "29.00" }, null)[0], "skip");
});

test("skip takes priority over missing intent", () => {
  const [action, reason] = decide({ status: "on-hold", total: "29.00" }, null);
  assert.equal(action, "skip");
  assert.match(reason, /not in a paid state/);
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

test("intentIdOf null when nothing saved", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "" }), null);
});

test("isRenewal true with meta key", () => {
  assert.equal(isRenewal({ meta_data: [{ key: "_subscription_renewal", value: "12" }] }), true);
});

test("isRenewal false without meta key", () => {
  assert.equal(isRenewal({ meta_data: [{ key: "_some_other_key", value: "x" }] }), false);
});

test("isRenewal false with no meta at all", () => {
  assert.equal(isRenewal({}), false);
});

test("orderAmountMinor converts to cents", () => {
  assert.equal(orderAmountMinor({ total: "29.00" }), 2900);
  assert.equal(orderAmountMinor({ total: "10.5" }), 1050);
});
