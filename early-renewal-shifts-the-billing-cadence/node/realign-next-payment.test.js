import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  expectedNextPayment,
  intentIdOf,
  orderAmountMinor,
  parseWcDate,
} from "./realign-next-payment.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });

const subscription = (over = {}) => ({
  billing_interval: 1,
  billing_period: "month",
  meta_data: [{ key: "_schedule_next_payment", value: "2026-07-15T00:00:00" }],
  ...over,
});

const renewalOrder = (over = {}) => ({
  total: "50.00",
  date_paid_gmt: "2026-06-10T00:00:00",
  date_created_gmt: "2026-06-10T00:00:00",
  ...over,
});

test("fix when next payment left on old cadence", () => {
  // Paid early on June 10. Correct next payment is July 10, but the
  // subscription still shows July 15, the old cadence, so it should fix.
  const sub = subscription({ meta_data: [{ key: "_schedule_next_payment", value: "2026-07-15T00:00:00" }] });
  assert.equal(decide(sub, renewalOrder(), intent())[0], "fix");
});

test("skip when next payment already correct", () => {
  const sub = subscription({ meta_data: [{ key: "_schedule_next_payment", value: "2026-07-10T00:00:00" }] });
  assert.equal(decide(sub, renewalOrder(), intent())[0], "skip");
});

test("skip when intent not succeeded", () => {
  assert.equal(decide(subscription(), renewalOrder(), intent({ status: "requires_payment_method" }))[0], "skip");
});

test("hold when no intent", () => {
  assert.equal(decide(subscription(), renewalOrder(), null)[0], "hold");
});

test("hold when amount mismatch", () => {
  assert.equal(decide(subscription(), renewalOrder({ total: "80.00" }), intent())[0], "hold");
});

test("hold when next payment missing", () => {
  assert.equal(decide(subscription({ meta_data: [] }), renewalOrder(), intent())[0], "hold");
});

test("hold when paid date missing", () => {
  const order = renewalOrder({ date_paid_gmt: null, date_created_gmt: null });
  assert.equal(decide(subscription(), order, intent())[0], "hold");
});

test("expectedNextPayment adds one period", () => {
  const paidAt = parseWcDate("2026-06-10T00:00:00");
  const result = expectedNextPayment(paidAt, 1, "month");
  assert.equal(result.toISOString().slice(0, 19), "2026-07-10T00:00:00");
});

test("expectedNextPayment respects interval", () => {
  const paidAt = parseWcDate("2026-06-10T00:00:00");
  const result = expectedNextPayment(paidAt, 2, "week");
  assert.equal(result.toISOString().slice(0, 19), "2026-06-24T00:00:00");
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

test("orderAmountMinor converts to cents", () => {
  assert.equal(orderAmountMinor({ total: "19.99" }), 1999);
});
