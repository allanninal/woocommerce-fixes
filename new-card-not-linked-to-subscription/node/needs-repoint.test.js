import { test } from "node:test";
import assert from "node:assert/strict";
import { needsRepoint } from "./repoint-sub-card.js";

test("repoint when different", () => {
  assert.equal(needsRepoint("pm_old", "pm_new"), true);
});

test("skip when same", () => {
  assert.equal(needsRepoint("pm_same", "pm_same"), false);
});

test("skip when no default", () => {
  assert.equal(needsRepoint("pm_old", null), false);
});

test("repoint when none stored", () => {
  assert.equal(needsRepoint(null, "pm_new"), true);
});
