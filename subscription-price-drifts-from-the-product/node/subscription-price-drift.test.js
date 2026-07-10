import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, lineItemTotalMinor, isDrift } from "./subscription-price-drift.js";

const subscription = (over = {}) => ({ id: 501, status: "active", total: "50.00", ...over });
const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });
const order = (over = {}) => ({
  meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }],
  transaction_id: "",
  ...over,
});

test("ok when total matches last charge", () => {
  const [action] = decide(subscription(), order(), intent());
  assert.equal(action, "ok");
  assert.equal(isDrift(action), false);
});

test("drift when subscription total is higher", () => {
  const [action] = decide(subscription({ total: "65.00" }), order(), intent());
  assert.equal(action, "drift_under_charged");
  assert.equal(isDrift(action), true);
});

test("drift when subscription total is lower", () => {
  const [action] = decide(subscription({ total: "35.00" }), order(), intent());
  assert.equal(action, "drift_over_charged");
  assert.equal(isDrift(action), true);
});

test("within tolerance is ok", () => {
  const [action] = decide(subscription({ total: "50.01" }), order(), intent());
  assert.equal(action, "ok");
});

test("skip when subscription not active", () => {
  const [action, reason] = decide(subscription({ status: "cancelled" }), order(), intent());
  assert.equal(action, "skip");
  assert.match(reason, /not active/);
});

test("skip when no last order", () => {
  const [action, reason] = decide(subscription(), null, null);
  assert.equal(action, "skip");
  assert.match(reason, /no billed order/);
});

test("skip when intent missing", () => {
  const [action, reason] = decide(subscription(), order(), null);
  assert.equal(action, "skip");
  assert.match(reason, /no matching/);
});

test("skip when intent not succeeded", () => {
  const [action, reason] = decide(subscription(), order(), intent({ status: "requires_payment_method" }));
  assert.equal(action, "skip");
  assert.match(reason, /did not succeed/);
});

test("intentIdOf from meta", () => {
  assert.equal(
    intentIdOf(order({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" })),
    "pi_123"
  );
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf(order({ meta_data: [], transaction_id: "pi_456" })), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf(order({ meta_data: [], transaction_id: "ch_789" })), null);
});

test("lineItemTotalMinor converts dollars to cents", () => {
  assert.equal(lineItemTotalMinor(subscription({ total: "12.34" })), 1234);
});
