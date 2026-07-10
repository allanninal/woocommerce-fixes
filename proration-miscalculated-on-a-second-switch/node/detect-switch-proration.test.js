import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, expectedProrationMinor, toMinor, intentIdOf } from "./detect-switch-proration.js";

const cycle = (over = {}) => ({
  daysRemaining: 15, daysInCycle: 30, oldPriceMinor: 4000, newPriceMinor: 6000, ...over,
});

test("ok when order matches expected and stripe", () => {
  const c = cycle();
  const expected = expectedProrationMinor(c.daysRemaining, c.daysInCycle, c.oldPriceMinor, c.newPriceMinor);
  const order = { total: (expected / 100).toFixed(2) };
  assert.equal(decide(order, 0, c, expected)[0], "ok");
});

test("flag when order total uses wrong baseline", () => {
  const c = cycle();
  // Bug: order was prorated against the original $20 plan instead of the $40
  // plan the first switch already set, so it charges too much.
  const wrongBaselineMinor = 2000;
  const wrongTotal = expectedProrationMinor(c.daysRemaining, c.daysInCycle, wrongBaselineMinor, c.newPriceMinor);
  const order = { total: (wrongTotal / 100).toFixed(2) };
  assert.equal(decide(order, 0, c, wrongTotal)[0], "flag");
});

test("flag when stripe amount disagrees with order total", () => {
  const c = cycle();
  const expected = expectedProrationMinor(c.daysRemaining, c.daysInCycle, c.oldPriceMinor, c.newPriceMinor);
  const order = { total: (expected / 100).toFixed(2) };
  assert.equal(decide(order, 0, c, expected + 500)[0], "flag");
});

test("ok when no stripe charge and order matches a pure credit", () => {
  const c = cycle({ oldPriceMinor: 6000, newPriceMinor: 4000 });
  const expected = expectedProrationMinor(c.daysRemaining, c.daysInCycle, c.oldPriceMinor, c.newPriceMinor);
  const order = { total: (expected / 100).toFixed(2) };
  assert.equal(decide(order, 0, c, null)[0], "ok");
});

test("expected proration is zero when days in cycle is zero", () => {
  assert.equal(expectedProrationMinor(10, 0, 1000, 2000), 0);
});

test("expected proration matches hand calculation", () => {
  // $40 to $60 plan, 15 of 30 days left: (6000-4000)/30 * 15 = 1000 cents.
  assert.equal(expectedProrationMinor(15, 30, 4000, 6000), 1000);
});

test("toMinor handles typical price strings", () => {
  assert.equal(toMinor("19.99"), 1999);
  assert.equal(toMinor("0.00"), 0);
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
