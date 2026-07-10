import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, expectedStockStatus } from "./fix-variation-stock-status.js";

const variation = (over = {}) => ({
  id: 501,
  manage_stock: true,
  stock_quantity: 0,
  backorders: "no",
  stock_status: "onbackorder",
  ...over,
});

test("fix when onbackorder at zero with backorders off", () => {
  const v = variation();
  const [action] = decide(v);
  assert.equal(action, "fix");
  assert.equal(expectedStockStatus(v), "outofstock");
});

test("skip when status already outofstock", () => {
  assert.equal(decide(variation({ stock_status: "outofstock" }))[0], "skip");
});

test("skip when backorders allowed and status matches", () => {
  assert.equal(decide(variation({ backorders: "yes", stock_status: "onbackorder" }))[0], "skip");
});

test("fix when backorders notify but status says outofstock", () => {
  const v = variation({ backorders: "notify", stock_status: "outofstock" });
  const [action] = decide(v);
  assert.equal(action, "fix");
  assert.equal(expectedStockStatus(v), "onbackorder");
});

test("fix when in stock quantity but marked outofstock", () => {
  const v = variation({ stock_quantity: 5, stock_status: "outofstock" });
  const [action] = decide(v);
  assert.equal(action, "fix");
  assert.equal(expectedStockStatus(v), "instock");
});

test("skip when variation does not manage stock", () => {
  const v = variation({ manage_stock: false });
  assert.equal(decide(v)[0], "skip");
  assert.equal(expectedStockStatus(v), null);
});

test("skip when quantity missing", () => {
  assert.equal(decide(variation({ stock_quantity: null }))[0], "skip");
});

test("fix when negative quantity and backorders off", () => {
  const v = variation({ stock_quantity: -2, backorders: "no", stock_status: "onbackorder" });
  const [action] = decide(v);
  assert.equal(action, "fix");
  assert.equal(expectedStockStatus(v), "outofstock");
});

test("fix when status is an unrecognized value", () => {
  assert.equal(decide(variation({ stock_status: "" }))[0], "fix");
});
