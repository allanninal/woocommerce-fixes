import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, expectedState, priceMinor } from "./resync-variable-parent.js";

const variation = (over = {}) => ({ status: "publish", price: "20.00", stock_status: "instock", ...over });
const parent = (over = {}) => ({ type: "variable", price: "20.00", stock_status: "instock", ...over });

test("priceMinor handles empty and null", () => {
  assert.equal(priceMinor(""), null);
  assert.equal(priceMinor(null), null);
  assert.equal(priceMinor("19.99"), 1999);
});

test("skip for simple product", () => {
  const [action] = decide({ type: "simple", price: "10.00" }, []);
  assert.equal(action, "skip");
});

test("skip when parent already matches", () => {
  const variations = [variation({ price: "20.00" }), variation({ price: "35.00" })];
  const [action] = decide(parent({ price: "20.00", stock_status: "instock" }), variations);
  assert.equal(action, "skip");
});

test("fix when cheapest variation was deleted", () => {
  const variations = [variation({ price: "20.00" }), variation({ price: "35.00" })];
  const [action, , expected] = decide(parent({ price: "15.00", stock_status: "instock" }), variations);
  assert.equal(action, "fix");
  assert.equal(expected.minPrice, 2000);
  assert.equal(expected.maxPrice, 3500);
});

test("fix when last in stock variation was deleted", () => {
  const variations = [variation({ price: "20.00", stock_status: "outofstock" })];
  const [action, , expected] = decide(parent({ price: "20.00", stock_status: "instock" }), variations);
  assert.equal(action, "fix");
  assert.equal(expected.stockStatus, "outofstock");
});

test("no-variations when every variation deleted", () => {
  const [action, , expected] = decide(parent({ price: "20.00", stock_status: "instock" }), []);
  assert.equal(action, "no-variations");
  assert.equal(expected.minPrice, null);
  assert.equal(expected.stockStatus, "outofstock");
});

test("skip when no variations and parent already cleared", () => {
  const [action] = decide(parent({ price: "", stock_status: "outofstock" }), []);
  assert.equal(action, "skip");
});

test("expectedState ignores draft variations", () => {
  const variations = [variation({ price: "20.00", status: "private" }), variation({ price: "35.00" })];
  const expected = expectedState(variations);
  assert.equal(expected.minPrice, 3500);
  assert.equal(expected.maxPrice, 3500);
});

test("expectedState backorder counts as purchasable", () => {
  const variations = [variation({ price: "20.00", stock_status: "onbackorder" })];
  const expected = expectedState(variations);
  assert.equal(expected.stockStatus, "onbackorder");
});

test("expectedState all out of stock", () => {
  const variations = [
    variation({ price: "20.00", stock_status: "outofstock" }),
    variation({ price: "30.00", stock_status: "outofstock" }),
  ];
  const expected = expectedState(variations);
  assert.equal(expected.stockStatus, "outofstock");
  assert.equal(expected.minPrice, 2000);
});
