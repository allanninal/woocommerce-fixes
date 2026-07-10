import { test } from "node:test";
import assert from "node:assert/strict";
import { isOversold } from "./fix-negative-stock.js";

const item = (over = {}) => ({ manage_stock: true, stock_quantity: -3, ...over });

test("oversold when managed and negative", () => {
  assert.equal(isOversold(item()), true);
});

test("not oversold when zero", () => {
  assert.equal(isOversold(item({ stock_quantity: 0 })), false);
});

test("not oversold when positive", () => {
  assert.equal(isOversold(item({ stock_quantity: 5 })), false);
});

test("not oversold when stock not managed", () => {
  assert.equal(isOversold(item({ manage_stock: false })), false);
});

test("not oversold when quantity is null", () => {
  assert.equal(isOversold(item({ stock_quantity: null })), false);
});
