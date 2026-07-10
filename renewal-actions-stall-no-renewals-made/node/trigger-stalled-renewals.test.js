import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, lastRenewalOrder, paymentMethodTokenOf, subscriptionAmountMinor } from "./trigger-stalled-renewals.js";

const sub = (over = {}) => ({ status: "active", total: "29.00", ...over });

test("trigger when due and no renewal order", () => {
  assert.equal(decide(sub(), false, "pm_1")[0], "trigger");
});

test("skip when renewal order already exists", () => {
  assert.equal(decide(sub(), true, "pm_1")[0], "skip");
});

test("skip when subscription not active", () => {
  assert.equal(decide(sub({ status: "on-hold" }), false, "pm_1")[0], "skip");
});

test("manual when no payment method saved", () => {
  assert.equal(decide(sub(), false, null)[0], "manual");
});

test("skip when zero cost renewal", () => {
  assert.equal(decide(sub({ total: "0.00" }), false, "pm_1")[0], "skip");
});

test("lastRenewalOrder returns most recent id", () => {
  assert.equal(lastRenewalOrder({ renewal_order_ids: [10, 11, 12] }), 12);
});

test("lastRenewalOrder returns null when empty", () => {
  assert.equal(lastRenewalOrder({ renewal_order_ids: [] }), null);
});

test("paymentMethodTokenOf reads from meta_data", () => {
  assert.equal(
    paymentMethodTokenOf({ meta_data: [{ key: "_stripe_payment_method", value: "pm_abc" }] }),
    "pm_abc"
  );
});

test("paymentMethodTokenOf null when missing", () => {
  assert.equal(paymentMethodTokenOf({ meta_data: [] }), null);
});

test("subscriptionAmountMinor converts to cents", () => {
  assert.equal(subscriptionAmountMinor({ total: "29.00" }), 2900);
});
