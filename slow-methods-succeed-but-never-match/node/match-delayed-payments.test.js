import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, orderAmountMinor } from "./match-delayed-payments.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, currency: "usd", id: "pi_1", ...over });
const order = (over = {}) => ({ status: "pending", total: "50.00", currency: "USD", ...over });

test("fix when pending and delayed method succeeded", () => {
  assert.equal(decide(order(), intent())[0], "fix");
});

test("skip when already processing", () => {
  assert.equal(decide(order({ status: "processing" }), intent())[0], "skip");
});

test("skip when already completed", () => {
  assert.equal(decide(order({ status: "completed" }), intent())[0], "skip");
});

test("skip when order cancelled", () => {
  assert.equal(decide(order({ status: "cancelled" }), intent())[0], "skip");
});

test("skip when order refunded", () => {
  assert.equal(decide(order({ status: "refunded" }), intent())[0], "skip");
});

test("mismatch when amount differs", () => {
  assert.equal(decide(order({ total: "40.00" }), intent())[0], "mismatch");
});

test("mismatch when currency differs", () => {
  assert.equal(decide(order({ currency: "EUR" }), intent())[0], "mismatch");
});

test("orphan when order missing", () => {
  assert.equal(decide(null, intent())[0], "orphan");
});

test("skip when intent not yet succeeded", () => {
  assert.equal(decide(order(), intent({ status: "processing" }))[0], "skip");
});

test("amount within one cent rounding still fixes", () => {
  assert.equal(decide(order({ total: "49.99" }), intent({ amount_received: 4999 }))[0], "fix");
});

test("orderAmountMinor converts dollars to cents", () => {
  assert.equal(orderAmountMinor({ total: "19.99" }), 1999);
});
