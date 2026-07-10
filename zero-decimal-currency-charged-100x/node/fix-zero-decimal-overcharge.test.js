import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  isZeroDecimal,
  expectedMinorUnits,
  intentIdOf,
} from "./fix-zero-decimal-overcharge.js";

const intent = (over = {}) => ({
  id: "pi_1",
  status: "succeeded",
  amount_received: 500000,
  amount_refunded: 0,
  ...over,
});

const jpyOrder = (over = {}) => ({ status: "processing", currency: "JPY", total: "5000", ...over });

test("isZeroDecimal is case insensitive", () => {
  assert.equal(isZeroDecimal("jpy"), true);
  assert.equal(isZeroDecimal("JPY"), true);
  assert.equal(isZeroDecimal("usd"), false);
  assert.equal(isZeroDecimal(undefined), false);
});

test("expectedMinorUnits zero decimal uses total as is", () => {
  assert.equal(expectedMinorUnits("5000", "JPY"), 5000);
});

test("expectedMinorUnits two decimal multiplies by 100", () => {
  assert.equal(expectedMinorUnits("50.00", "USD"), 5000);
});

test("refund when JPY order charged 100x", () => {
  const [action, , overcharge] = decide(jpyOrder(), intent());
  assert.equal(action, "refund");
  assert.equal(overcharge, 495000);
});

test("ok when JPY order charged the right amount", () => {
  const order = jpyOrder();
  const charge = intent({ amount_received: 5000 });
  assert.equal(decide(order, charge)[0], "ok");
});

test("skip when currency is not zero decimal", () => {
  const order = { status: "processing", currency: "USD", total: "50.00" };
  assert.equal(decide(order, intent({ amount_received: 5000 }))[0], "skip");
});

test("skip when order not paid", () => {
  const order = jpyOrder({ status: "pending" });
  assert.equal(decide(order, intent())[0], "skip");
});

test("skip when no intent", () => {
  assert.equal(decide(jpyOrder(), null)[0], "skip");
});

test("skip when intent not succeeded", () => {
  const action = decide(jpyOrder(), intent({ status: "requires_payment_method" }))[0];
  assert.equal(action, "skip");
});

test("mismatch when overcharge is not the 100x pattern", () => {
  const [action, , overcharge] = decide(jpyOrder(), intent({ amount_received: 5100 }));
  assert.equal(action, "mismatch");
  assert.equal(overcharge, 0);
});

test("ok when overcharge already fully refunded", () => {
  const action = decide(jpyOrder(), intent({ amount_refunded: 495000 }))[0];
  assert.equal(action, "ok");
});

test("refund is reduced by a partial prior refund", () => {
  const [action, , overcharge] = decide(jpyOrder(), intent({ amount_refunded: 100000 }));
  assert.equal(action, "refund");
  assert.equal(overcharge, 395000);
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

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});
