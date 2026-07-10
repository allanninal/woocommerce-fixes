import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isManual, intentIdOf } from "./stop-billing-on-disabled-gateway.js";

const sub = (over = {}) => ({
  status: "active", payment_method: "woocommerce_payments", requires_manual_renewal: false, ...over,
});

test("repair when active on disabled gateway", () => {
  assert.equal(decide(sub(), ["woocommerce_payments"])[0], "repair");
});

test("repair when on-hold on disabled gateway", () => {
  assert.equal(decide(sub({ status: "on-hold" }), ["woocommerce_payments"])[0], "repair");
});

test("skip when already manual (boolean)", () => {
  assert.equal(decide(sub({ requires_manual_renewal: true }), ["woocommerce_payments"])[0], "skip");
});

test("skip when already manual (string true)", () => {
  assert.equal(decide(sub({ requires_manual_renewal: "true" }), ["woocommerce_payments"])[0], "skip");
});

test("skip when gateway not disabled", () => {
  assert.equal(decide(sub({ payment_method: "stripe" }), ["woocommerce_payments"])[0], "skip");
});

test("skip when not a billable status (cancelled)", () => {
  assert.equal(decide(sub({ status: "cancelled" }), ["woocommerce_payments"])[0], "skip");
});

test("skip when not a billable status (pending-cancel)", () => {
  assert.equal(decide(sub({ status: "pending-cancel" }), ["woocommerce_payments"])[0], "skip");
});

test("skip when payment method missing", () => {
  assert.equal(decide(sub({ payment_method: "" }), ["woocommerce_payments"])[0], "skip");
});

test("repair reason includes the method name", () => {
  const [action, reason] = decide(sub(), ["woocommerce_payments"]);
  assert.equal(action, "repair");
  assert.match(reason, /woocommerce_payments/);
});

test("isManual true for boolean true", () => {
  assert.equal(isManual({ requires_manual_renewal: true }), true);
});

test("isManual true for string true", () => {
  assert.equal(isManual({ requires_manual_renewal: "true" }), true);
});

test("isManual true for number 1", () => {
  assert.equal(isManual({ requires_manual_renewal: 1 }), true);
});

test("isManual false when missing", () => {
  assert.equal(isManual({}), false);
});

test("intentIdOf from meta", () => {
  const order = { meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" };
  assert.equal(intentIdOf(order), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("intentIdOf null when order is null", () => {
  assert.equal(intentIdOf(null), null);
});
