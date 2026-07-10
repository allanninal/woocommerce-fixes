import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./find-orphaned-variations.js";

const variation = (over = {}) => ({ id: 501, parent_id: 100, ...over });
const parent = (over = {}) => ({ id: 100, type: "variable", status: "publish", ...over });

test("ok when parent exists and variable", () => {
  assert.equal(decide(variation(), parent())[0], "ok");
});

test("orphan when parent missing", () => {
  assert.equal(decide(variation(), null)[0], "orphan");
});

test("orphan when parent trashed", () => {
  assert.equal(decide(variation(), parent({ status: "trash" }))[0], "orphan");
});

test("orphan when parent converted to simple", () => {
  assert.equal(decide(variation(), parent({ type: "simple" }))[0], "orphan");
});

test("skip when variation itself gone", () => {
  assert.equal(decide(null, null)[0], "skip");
});

test("skip when no parent_id set", () => {
  assert.equal(decide(variation({ parent_id: null }), parent())[0], "skip");
});
