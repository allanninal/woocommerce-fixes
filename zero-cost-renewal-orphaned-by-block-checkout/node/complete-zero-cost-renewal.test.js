import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, isRenewalOrder, orderTotalMinor } from "./complete-zero-cost-renewal.js";

const renewalOrder = (over = {}) => ({
  status: "pending",
  total: "0.00",
  created_via: "subscription",
  meta_data: [{ key: "_subscription_renewal", value: "123" }],
  ...over,
});

test("complete when zero cost renewal with no intent", () => {
  assert.equal(decide(renewalOrder())[0], "complete");
});

test("skip when not a renewal order", () => {
  assert.equal(decide(renewalOrder({ meta_data: [] }))[0], "skip");
});

test("skip when order already paid", () => {
  assert.equal(decide(renewalOrder({ status: "processing" }))[0], "skip");
});

test("skip when total is not zero cost", () => {
  assert.equal(decide(renewalOrder({ total: "19.99" }))[0], "skip");
});

test("skip when a payment intent is attached", () => {
  const order = renewalOrder({
    meta_data: [
      { key: "_subscription_renewal", value: "123" },
      { key: "_stripe_intent_id", value: "pi_abc" },
    ],
  });
  assert.equal(decide(order)[0], "skip");
});

test("review when created_via is unexpected", () => {
  assert.equal(decide(renewalOrder({ created_via: "import" }))[0], "review");
});

test("orderTotalMinor rounds to cents", () => {
  assert.equal(orderTotalMinor({ total: "0.00" }), 0);
  assert.equal(orderTotalMinor({ total: "19.99" }), 1999);
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

test("intentIdOf none when no payment reference", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "" }), null);
});

test("isRenewalOrder true only with renewal meta", () => {
  assert.equal(isRenewalOrder({ meta_data: [{ key: "_subscription_renewal", value: "9" }] }), true);
  assert.equal(isRenewalOrder({ meta_data: [] }), false);
  assert.equal(isRenewalOrder({}), false);
});
