import { test } from "node:test";
import assert from "node:assert/strict";
import { isOutOfStock, decideProduct, decideOrder, intentIdOf } from "./fix-purchasable-stock.js";

const product = (over = {}) => ({
  id: 101,
  stock_status: "outofstock",
  manage_stock: true,
  stock_quantity: 0,
  backorders: "no",
  purchasable: true,
  catalog_visibility: "visible",
  ...over,
});

const order = (over = {}) => ({
  id: 555,
  status: "processing",
  line_items: [{ product_id: 101 }],
  ...over,
});

const intent = (over = {}) => ({ status: "succeeded", id: "pi_1", ...over });

test("isOutOfStock: stock_status flag wins", () => {
  assert.equal(isOutOfStock(product({ stock_status: "outofstock", manage_stock: false })), true);
});

test("isOutOfStock: instock with unmanaged stock is not out of stock", () => {
  assert.equal(isOutOfStock(product({ stock_status: "instock", manage_stock: false })), false);
});

test("isOutOfStock: managed stock zero, no backorders, is out of stock", () => {
  assert.equal(isOutOfStock(product({ stock_status: "instock", stock_quantity: 0, backorders: "no" })), true);
});

test("isOutOfStock: managed stock zero, backorders allowed, is not out of stock", () => {
  assert.equal(isOutOfStock(product({ stock_status: "instock", stock_quantity: 0, backorders: "yes" })), false);
});

test("isOutOfStock: managed stock positive is not out of stock", () => {
  assert.equal(isOutOfStock(product({ stock_status: "instock", stock_quantity: 5 })), false);
});

test("decideProduct: repair when out of stock and purchasable", () => {
  assert.equal(decideProduct(product({ purchasable: true, catalog_visibility: "visible" }))[0], "repair");
});

test("decideProduct: repair when out of stock and still listed even if not purchasable", () => {
  assert.equal(decideProduct(product({ purchasable: false, catalog_visibility: "visible" }))[0], "repair");
});

test("decideProduct: skip when already locked down", () => {
  assert.equal(decideProduct(product({ purchasable: false, catalog_visibility: "search" }))[0], "skip");
});

test("decideProduct: skip when in stock", () => {
  assert.equal(decideProduct(product({ stock_status: "instock", manage_stock: false }))[0], "skip");
});

test("decideOrder: flag_charged when order open and payment succeeded", () => {
  assert.equal(decideOrder(order(), intent(), new Set([101]))[0], "flag_charged");
});

test("decideOrder: flag_uncharged when order open and no intent", () => {
  assert.equal(decideOrder(order(), null, new Set([101]))[0], "flag_uncharged");
});

test("decideOrder: flag_uncharged when intent not succeeded", () => {
  assert.equal(decideOrder(order(), intent({ status: "requires_payment_method" }), new Set([101]))[0], "flag_uncharged");
});

test("decideOrder: skip when order not open", () => {
  assert.equal(decideOrder(order({ status: "completed" }), intent(), new Set([101]))[0], "skip");
});

test("decideOrder: skip when order has no repaired product", () => {
  assert.equal(decideOrder(order({ line_items: [{ product_id: 999 }] }), intent(), new Set([101]))[0], "skip");
});

test("intentIdOf: from meta", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }), "pi_123");
});

test("intentIdOf: falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf: none when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});
