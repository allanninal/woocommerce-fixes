import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReactivate } from "./reactivate-paid-subs.js";

test("reactivate when order paid", () => {
  assert.equal(shouldReactivate("on-hold", true, false), true);
});

test("reactivate when stripe paid", () => {
  assert.equal(shouldReactivate("on-hold", false, true), true);
});

test("leave when not paid", () => {
  assert.equal(shouldReactivate("on-hold", false, false), false);
});

test("ignore non on-hold", () => {
  assert.equal(shouldReactivate("active", true, true), false);
});
