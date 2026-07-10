import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./decide.js";

const order = (over = {}) => ({ status: "processing", ...over });

test("fix when reduced exactly twice", () => {
  const [action, , extra] = decide(order(), 3, 6);
  assert.equal(action, "fix");
  assert.equal(extra, 3);
});

test("fix when reduced three times", () => {
  const [action, , extra] = decide(order(), 2, 6);
  assert.equal(action, "fix");
  assert.equal(extra, 4);
});

test("skip when reduction matches order", () => {
  const [action, , extra] = decide(order(), 3, 3);
  assert.equal(action, "skip");
  assert.equal(extra, 0);
});

test("skip when reduction under order total", () => {
  assert.equal(decide(order(), 5, 3)[0], "skip");
});

test("review when not a clean multiple", () => {
  assert.equal(decide(order(), 3, 7)[0], "review");
});

test("skip when order not in reduced state", () => {
  assert.equal(decide(order({ status: "pending" }), 3, 6)[0], "skip");
});

test("skip when no recorded reduction", () => {
  assert.equal(decide(order(), 3, null)[0], "skip");
});

test("skip when no expected qty", () => {
  assert.equal(decide(order(), 0, 6)[0], "skip");
});

test("orphan when order missing", () => {
  assert.equal(decide(null, 3, 6)[0], "orphan");
});
