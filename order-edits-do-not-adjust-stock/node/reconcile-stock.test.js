import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, lineItemsNeedingSync, reducedStockOf, applyDelta } from "./reconcile-stock.js";

const lineItem = (over = {}) => ({
  product_id: 42,
  variation_id: 0,
  sku: "WIDGET",
  quantity: 2,
  meta_data: [{ key: "_reduced_stock", value: "2" }],
  ...over,
});

const product = (over = {}) => ({ manage_stock: true, stock_quantity: 10, ...over });

test("reducedStockOf reads meta", () => {
  assert.equal(reducedStockOf(lineItem()), 2);
});

test("reducedStockOf defaults to zero without meta", () => {
  assert.equal(reducedStockOf(lineItem({ meta_data: [] })), 0);
});

test("needs sync when quantity was edited up", () => {
  const order = { status: "processing", line_items: [lineItem({ quantity: 5 })] };
  const out = lineItemsNeedingSync(order);
  assert.equal(out.length, 1);
  assert.equal(out[0].delta, 3);
});

test("needs sync when quantity was edited down", () => {
  const order = { status: "processing", line_items: [lineItem({ quantity: 1 })] };
  assert.equal(lineItemsNeedingSync(order)[0].delta, -1);
});

test("no sync needed when quantity unchanged", () => {
  const order = { status: "processing", line_items: [lineItem({ quantity: 2 })] };
  assert.deepEqual(lineItemsNeedingSync(order), []);
});

test("skips orders not in a stock reducing status", () => {
  const order = { status: "pending", line_items: [lineItem({ quantity: 5 })] };
  assert.deepEqual(lineItemsNeedingSync(order), []);
});

test("skips line items without a product id", () => {
  const order = { status: "processing", line_items: [lineItem({ product_id: null, quantity: 5 })] };
  assert.deepEqual(lineItemsNeedingSync(order), []);
});

test("new line item added after reduction needs full sync", () => {
  const order = { status: "processing", line_items: [lineItem({ quantity: 3, meta_data: [] })] };
  const out = lineItemsNeedingSync(order);
  assert.equal(out[0].reduced, 0);
  assert.equal(out[0].delta, 3);
});

test("decide skip when order not stock reducing", () => {
  assert.equal(decide({ status: "pending" }, product())[0], "skip");
});

test("decide orphan when product missing", () => {
  assert.equal(decide({ status: "processing" }, null)[0], "orphan");
});

test("decide unmanaged when product does not track stock", () => {
  assert.equal(decide({ status: "processing" }, product({ manage_stock: false }))[0], "unmanaged");
});

test("decide adjust when stock managed and order paid", () => {
  assert.equal(decide({ status: "completed" }, product())[0], "adjust");
});

test("applyDelta adds back stock", () => {
  assert.equal(applyDelta(10, 3), 13);
});

test("applyDelta removes stock", () => {
  assert.equal(applyDelta(10, -3), 7);
});

test("applyDelta never goes negative", () => {
  assert.equal(applyDelta(2, -5), 0);
});
