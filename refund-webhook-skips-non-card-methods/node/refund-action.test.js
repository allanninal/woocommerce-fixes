import { test } from "node:test";
import assert from "node:assert/strict";
import { isStripeApm, refundAction } from "./sync-apm-refunds.js";

test("apm detected", () => {
  assert.equal(isStripeApm("stripe_ideal"), true);
  assert.equal(isStripeApm("stripe"), false);
  assert.equal(isStripeApm("paypal"), false);
});

test("records missing and marks full", () => {
  const { missing, fully } = refundAction(5000, 5000, 0);
  assert.equal(missing, 5000);
  assert.equal(fully, true);
});

test("partial refund not full", () => {
  const { missing, fully } = refundAction(5000, 2000, 0);
  assert.equal(missing, 2000);
  assert.equal(fully, false);
});

test("nothing when matched", () => {
  const { missing, fully } = refundAction(5000, 2000, 2000);
  assert.equal(missing, 0);
  assert.equal(fully, false);
});
