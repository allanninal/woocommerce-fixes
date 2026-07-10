import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, customerIdOf } from "./push-card-to-stripe.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, payment_method: "pm_new", ...over });
const customer = (defaultPm) => ({ invoice_settings: { default_payment_method: defaultPm } });
const order = (over = {}) => ({ status: "processing", total: "50.00", ...over });

test("push when Stripe default is the old card", () => {
  assert.equal(decide(order(), intent(), customer("pm_old"))[0], "push");
});

test("already-synced when Stripe default matches", () => {
  assert.equal(decide(order(), intent(), customer("pm_new"))[0], "already-synced");
});

test("skip when order not paid", () => {
  assert.equal(decide(order({ status: "pending" }), intent(), customer("pm_old"))[0], "skip");
});

test("skip when intent not succeeded", () => {
  assert.equal(decide(order(), intent({ status: "requires_payment_method" }), customer("pm_old"))[0], "skip");
});

test("orphan when no intent", () => {
  assert.equal(decide(order(), null, customer("pm_old"))[0], "orphan");
});

test("orphan when intent has no payment_method", () => {
  assert.equal(decide(order(), intent({ payment_method: null }), customer("pm_old"))[0], "orphan");
});

test("orphan when no customer", () => {
  assert.equal(decide(order(), intent(), null)[0], "orphan");
});

test("mismatch when amount differs", () => {
  assert.equal(decide(order({ total: "80.00" }), intent(), customer("pm_old"))[0], "mismatch");
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

test("customerIdOf from meta", () => {
  assert.equal(customerIdOf({ meta_data: [{ key: "_stripe_customer_id", value: "cus_1" }] }), "cus_1");
});

test("customerIdOf null when missing", () => {
  assert.equal(customerIdOf({ meta_data: [] }), null);
});
