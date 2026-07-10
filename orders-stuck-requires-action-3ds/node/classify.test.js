import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./resolve-3ds.js";

test("complete when succeeded", () => {
  assert.equal(classify("succeeded", 0.1, 6), "complete");
});

test("fail when old and waiting", () => {
  assert.equal(classify("requires_action", 8, 6), "fail");
});

test("wait when recent and waiting", () => {
  assert.equal(classify("requires_action", 1, 6), "wait");
});

test("wait for an unknown status", () => {
  assert.equal(classify("canceled", 100, 6), "wait");
});
