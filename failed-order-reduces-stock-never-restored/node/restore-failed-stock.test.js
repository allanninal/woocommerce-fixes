import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, reducedStockFlag, restockableItems } from "./restore-failed-stock.js";

function order(over = {}) {
  return {
    status: "failed",
    meta_data: [{ key: "_order_stock_reduced", value: "1" }],
    line_items: [{ product_id: 101, quantity: 2 }],
    ...over,
  };
}

test("restore when failed and flag set", () => {
  assert.equal(decide(order())[0], "restore");
});

test("restore when cancelled and flag set", () => {
  assert.equal(decide(order({ status: "cancelled" }))[0], "restore");
});

test("skip when order still pending", () => {
  assert.equal(decide(order({ status: "pending" }))[0], "skip");
});

test("skip when flag already cleared", () => {
  const o = order({ meta_data: [{ key: "_order_stock_reduced", value: "0" }] });
  assert.equal(decide(o)[0], "skip");
});

test("skip when flag missing entirely", () => {
  const o = order({ meta_data: [] });
  assert.equal(decide(o)[0], "skip");
});

test("skip when no restockable line items", () => {
  const o = order({ line_items: [{ product_id: null, quantity: 2 }] });
  assert.equal(decide(o)[0], "skip");
});

test("reducedStockFlag true", () => {
  assert.equal(reducedStockFlag(order()), true);
});

test("reducedStockFlag false when zero", () => {
  const o = order({ meta_data: [{ key: "_order_stock_reduced", value: "0" }] });
  assert.equal(reducedStockFlag(o), false);
});

test("restockableItems uses variation_id when present", () => {
  const o = order({ line_items: [{ product_id: 101, variation_id: 202, quantity: 3 }] });
  assert.deepEqual(restockableItems(o), [{ product_id: 202, quantity: 3 }]);
});

test("restockableItems skips zero quantity", () => {
  const o = order({ line_items: [{ product_id: 101, quantity: 0 }] });
  assert.deepEqual(restockableItems(o), []);
});

test("intentIdOf from meta", () => {
  const o = order({
    meta_data: [
      { key: "_order_stock_reduced", value: "1" },
      { key: "_stripe_intent_id", value: "pi_123" },
    ],
  });
  assert.equal(intentIdOf(o), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  const o = order({
    meta_data: [{ key: "_order_stock_reduced", value: "1" }],
    transaction_id: "pi_456",
  });
  assert.equal(intentIdOf(o), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  const o = order({
    meta_data: [{ key: "_order_stock_reduced", value: "1" }],
    transaction_id: "ch_789",
  });
  assert.equal(intentIdOf(o), null);
});
