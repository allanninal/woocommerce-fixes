import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, daysUntil, getMeta } from "./find-unsaved-renewal-cards.js";

const NOW = new Date("2026-07-10T00:00:00Z");

const subscription = (over = {}) => ({
  id: 501,
  status: "active",
  payment_method: "stripe",
  next_payment_date_gmt: "2026-07-11T00:00:00",
  ...over,
});

const order = (over = {}) => ({
  id: 900,
  status: "processing",
  meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }],
  ...over,
});

const intent = (over = {}) => ({
  status: "succeeded",
  customer: "cus_1",
  payment_method: "pm_1",
  ...over,
});

test("ok when reusable card attached", () => {
  assert.equal(decide(subscription(), order(), intent(), NOW)[0], "ok");
});

test("flag when no customer on intent", () => {
  assert.equal(decide(subscription(), order(), intent({ customer: null }), NOW)[0], "flag");
});

test("flag when no payment method on intent", () => {
  assert.equal(decide(subscription(), order(), intent({ payment_method: null }), NOW)[0], "flag");
});

test("skip when subscription not active", () => {
  assert.equal(decide(subscription({ status: "cancelled" }), order(), intent(), NOW)[0], "skip");
});

test("skip when not stripe gateway", () => {
  assert.equal(decide(subscription({ payment_method: "paypal" }), order(), intent(), NOW)[0], "skip");
});

test("skip when renewal not due soon", () => {
  const sub = subscription({ next_payment_date_gmt: "2026-08-10T00:00:00" });
  assert.equal(decide(sub, order(), intent(), NOW)[0], "skip");
});

test("skip when no parent order", () => {
  assert.equal(decide(subscription(), null, intent(), NOW)[0], "skip");
});

test("skip when no intent found", () => {
  assert.equal(decide(subscription(), order(), null, NOW)[0], "skip");
});

test("skip when intent not succeeded", () => {
  assert.equal(decide(subscription(), order(), intent({ status: "requires_payment_method" }), NOW)[0], "skip");
});

test("intentIdOf from meta", () => {
  const o = order({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }] });
  assert.equal(intentIdOf(o), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  const o = order({ meta_data: [], transaction_id: "pi_456" });
  assert.equal(intentIdOf(o), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  const o = order({ meta_data: [], transaction_id: "ch_789" });
  assert.equal(intentIdOf(o), null);
});

test("daysUntil null when missing", () => {
  assert.equal(daysUntil(null, NOW), null);
});

test("daysUntil positive for future date", () => {
  assert.equal(Math.round(daysUntil("2026-07-15T00:00:00", NOW)), 5);
});

test("getMeta returns value for matching key", () => {
  assert.equal(getMeta({ meta_data: [{ key: "a", value: "b" }] }, "a"), "b");
});

test("getMeta returns null when missing", () => {
  assert.equal(getMeta({ meta_data: [] }, "a"), null);
});
