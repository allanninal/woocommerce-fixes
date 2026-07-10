import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, groupBySku } from "./sku-audit.js";

const entries = (n, startId = 1, type = "product") =>
  Array.from({ length: n }, (_, i) => ({ productId: startId + i, type }));

test("ok when unique sku", () => {
  assert.equal(decide("ABC-1", entries(1), false)[0], "ok");
});

test("auto_fixable when duplicate and no paid order", () => {
  const [action, reason] = decide("ABC-1", entries(2), false);
  assert.equal(action, "auto_fixable");
  assert.match(reason, /shared by 2/);
});

test("review when duplicate and paid order exists", () => {
  const [action, reason] = decide("ABC-1", entries(2), true);
  assert.equal(action, "review");
  assert.match(reason, /paid order/);
});

test("auto_fixable when missing sku and no paid order", () => {
  const [action, reason] = decide("", entries(3), false);
  assert.equal(action, "auto_fixable");
  assert.match(reason, /missing SKU/);
});

test("review when missing sku and paid order exists", () => {
  const [action, reason] = decide("", entries(1), true);
  assert.equal(action, "review");
  assert.match(reason, /missing SKU/);
});

test("groupBySku groups correctly", () => {
  const products = [
    { id: 1, sku: "ABC-1", type: "product" },
    { id: 2, sku: "ABC-1", type: "variation" },
    { id: 3, sku: "", type: "product" },
    { id: 4, sku: " ", type: "product" },
    { id: 5, sku: "XYZ-9", type: "product" },
  ];
  const groups = groupBySku(products);
  assert.equal(groups.get("ABC-1").length, 2);
  assert.equal(groups.get("").length, 2);
  assert.equal(groups.get("XYZ-9").length, 1);
});

test("groupBySku strips whitespace", () => {
  const groups = groupBySku([{ id: 1, sku: "  SPACED-1  ", type: "product" }]);
  assert.ok(groups.has("SPACED-1"));
  assert.ok(!groups.has(" SPACED-1  "));
});
