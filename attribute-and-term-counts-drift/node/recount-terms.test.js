import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./recount-terms.js";

test("skip when count already correct", () => {
  assert.equal(decide({ count: 42 }, 42)[0], "skip");
});

test("repair when count too high", () => {
  assert.equal(decide({ count: 42 }, 31)[0], "repair");
});

test("repair when count too low", () => {
  assert.equal(decide({ count: 5 }, 12)[0], "repair");
});

test("skip when real is negative", () => {
  assert.equal(decide({ count: 5 }, -1)[0], "skip");
});

test("defaults stored count to zero", () => {
  const [action, reason] = decide({}, 3);
  assert.equal(action, "repair");
  assert.match(reason, /stored 0/);
});

test("repair reason includes both numbers", () => {
  const [action, reason] = decide({ count: 10 }, 4);
  assert.equal(action, "repair");
  assert.match(reason, /stored 10/);
  assert.match(reason, /real 4/);
});

test("zero is a valid real count", () => {
  assert.equal(decide({ count: 3 }, 0)[0], "repair");
  assert.equal(decide({ count: 0 }, 0)[0], "skip");
});
