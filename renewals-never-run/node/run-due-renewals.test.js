import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, orderAmountMinor } from "./run-due-renewals.js";

const NOW = 1_800_000_000; // a fixed "now" for deterministic tests
const HOUR = 3600;
const DAY = 24 * HOUR;

const sub = (over = {}) => ({
  status: "active",
  nextPaymentTs: NOW - 5 * HOUR,
  lastOrderStatus: "pending",
  paymentMethodToken: "pm_123",
  ...over,
});

test("charge when past due and past grace", () => {
  assert.equal(decide(sub(), NOW)[0], "charge");
});

test("wait when inside grace window", () => {
  assert.equal(decide(sub({ nextPaymentTs: NOW - 1 * HOUR }), NOW)[0], "wait");
});

test("skip when not due yet", () => {
  assert.equal(decide(sub({ nextPaymentTs: NOW + 1 * HOUR }), NOW)[0], "skip");
});

test("skip when subscription not active", () => {
  assert.equal(decide(sub({ status: "cancelled" }), NOW)[0], "skip");
});

test("skip when no renewal scheduled", () => {
  assert.equal(decide(sub({ nextPaymentTs: null }), NOW)[0], "skip");
});

test("skip when renewal already paid", () => {
  assert.equal(decide(sub({ lastOrderStatus: "processing" }), NOW)[0], "skip");
});

test("blocked when no payment method", () => {
  assert.equal(decide(sub({ paymentMethodToken: null }), NOW)[0], "blocked");
});

test("stale when overdue past stale window", () => {
  assert.equal(decide(sub({ nextPaymentTs: NOW - 20 * DAY }), NOW)[0], "stale");
});

test("grace and stale windows are configurable", () => {
  const s = sub({ nextPaymentTs: NOW - 2 * HOUR });
  assert.equal(decide(s, NOW, 1, 14)[0], "charge");
  assert.equal(decide(s, NOW, 6, 14)[0], "wait");
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
  assert.equal(orderAmountMinor({ total: "49.99" }), 4999);
});
