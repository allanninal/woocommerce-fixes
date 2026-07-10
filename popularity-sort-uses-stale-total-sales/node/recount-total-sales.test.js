import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, netQuantity } from "./recount-total-sales.js";

test("skip when totals match", () => {
  assert.equal(decide(12, 12)[0], "skip");
});

test("fix when stored is lower than real", () => {
  assert.equal(decide(3, 40)[0], "fix");
});

test("fix when stored is higher than real", () => {
  assert.equal(decide(40, 3)[0], "fix");
});

test("fix when stored is missing", () => {
  assert.equal(decide(null, 5)[0], "fix");
});

test("skip when stored is missing and real is zero", () => {
  assert.equal(decide(null, 0)[0], "skip");
});

test("negative real total is floored at zero", () => {
  const [action, reason] = decide(0, -4);
  assert.equal(action, "skip");
  assert.equal(reason, "total_sales already correct");
});

test("netQuantity reads order line item", () => {
  assert.equal(netQuantity({ quantity: 3 }), 3);
});

test("netQuantity reads negative refund line item", () => {
  assert.equal(netQuantity({ quantity: -2 }), -2);
});

test("netQuantity defaults to zero when missing", () => {
  assert.equal(netQuantity({}), 0);
});
