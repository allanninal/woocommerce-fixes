import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, decideBatch, intentIdOf, orderAmountMinor } from "./paginate-orders.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, id: "pi_1", ...over });
const order = (over = {}) => ({ id: 100, status: "pending", total: "50.00", ...over });

// decideBatch: the stable-sort walk itself

test("first page has no repeats", () => {
  const batch = [order({ id: 1 }), order({ id: 2 }), order({ id: 3 })];
  const result = decideBatch(batch, null);
  assert.deepEqual(result.newOrders.map((o) => o.id), [1, 2, 3]);
  assert.equal(result.repeats, 0);
  assert.equal(result.nextFloor, 3);
});

test("next page only keeps ids above the floor", () => {
  const batch = [order({ id: 3 }), order({ id: 4 }), order({ id: 5 })];
  const result = decideBatch(batch, 3);
  assert.deepEqual(result.newOrders.map((o) => o.id), [4, 5]);
  assert.equal(result.repeats, 1);
  assert.equal(result.nextFloor, 5);
});

test("a row that shifted back a page is dropped as a repeat, not lost", () => {
  const batch = [order({ id: 10 }), order({ id: 11 })];
  const result = decideBatch(batch, 11);
  assert.deepEqual(result.newOrders, []);
  assert.equal(result.repeats, 2);
  assert.equal(result.nextFloor, 11);
});

test("empty batch keeps the same floor", () => {
  const result = decideBatch([], 7);
  assert.deepEqual(result.newOrders, []);
  assert.equal(result.nextFloor, 7);
});

// decide: whether an order needs repair

test("fix when Stripe succeeded but order still unpaid", () => {
  assert.equal(decide(order({ status: "pending" }), intent())[0], "fix");
});

test("skip when no intent saved", () => {
  assert.equal(decide(order({ status: "pending" }), null)[0], "skip");
});

test("skip when order already paid", () => {
  assert.equal(decide(order({ status: "processing" }), intent())[0], "skip");
});

test("skip when intent not succeeded", () => {
  assert.equal(decide(order({ status: "pending" }), intent({ status: "requires_payment_method" }))[0], "skip");
});

test("mismatch when amount differs", () => {
  assert.equal(decide(order({ status: "pending", total: "40.00" }), intent())[0], "mismatch");
});

// helpers

test("intentIdOf from meta", () => {
  const o = order({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" });
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

test("orderAmountMinor converts to cents", () => {
  assert.equal(orderAmountMinor(order({ total: "19.99" })), 1999);
});
