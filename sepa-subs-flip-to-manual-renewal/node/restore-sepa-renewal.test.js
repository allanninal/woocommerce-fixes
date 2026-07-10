import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, customerIdOf } from "./restore-sepa-renewal.js";

const paymentMethod = (over = {}) => ({ id: "pm_1", sepa_debit: { last4: "1234" }, disabled: false, ...over });

test("repair when manual and mandate attached", () => {
  assert.equal(decide({ status: "active", requires_manual_renewal: true }, paymentMethod())[0], "repair");
});

test("skip when already automatic", () => {
  assert.equal(decide({ status: "active", requires_manual_renewal: false }, paymentMethod())[0], "skip");
});

test("skip when not active", () => {
  assert.equal(decide({ status: "on-hold", requires_manual_renewal: true }, paymentMethod())[0], "skip");
});

test("hold when no payment method", () => {
  assert.equal(decide({ status: "active", requires_manual_renewal: true }, null)[0], "hold");
});

test("hold when payment method disabled", () => {
  assert.equal(decide({ status: "active", requires_manual_renewal: true }, paymentMethod({ disabled: true }))[0], "hold");
});

test("customerIdOf from meta", () => {
  assert.equal(customerIdOf({ meta_data: [{ key: "_stripe_customer_id", value: "cus_123" }] }), "cus_123");
});

test("customerIdOf null when missing", () => {
  assert.equal(customerIdOf({ meta_data: [{ key: "_other_key", value: "x" }] }), null);
});
