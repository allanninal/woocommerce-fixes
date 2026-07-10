import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, groupByFingerprint } from "./dedupe-saved-cards.js";

const pm = (id, fingerprint = "fp_abc", created = 1000) => ({ id, created, card: { fingerprint } });

test("single card is kept", () => {
  const result = decide([pm("pm_1")], new Set());
  assert.deepEqual([...result], [["pm_1", "keep"]]);
});

test("duplicates keep newest when none in use", () => {
  const group = [pm("pm_1", "fp_abc", 1000), pm("pm_2", "fp_abc", 2000), pm("pm_3", "fp_abc", 1500)];
  const result = decide(group, new Set());
  assert.equal(result.get("pm_1"), "detach");
  assert.equal(result.get("pm_2"), "keep");
  assert.equal(result.get("pm_3"), "detach");
});

test("duplicates keep the one used by a subscription", () => {
  const group = [pm("pm_1", "fp_abc", 1000), pm("pm_2", "fp_abc", 2000)];
  const result = decide(group, new Set(["pm_1"]));
  assert.equal(result.get("pm_1"), "keep");
  assert.equal(result.get("pm_2"), "detach");
});

test("multiple in use are all kept", () => {
  const group = [pm("pm_1"), pm("pm_2"), pm("pm_3")];
  const result = decide(group, new Set(["pm_1", "pm_2"]));
  assert.equal(result.get("pm_1"), "keep");
  assert.equal(result.get("pm_2"), "keep");
  assert.equal(result.get("pm_3"), "detach");
});

test("groupByFingerprint splits different cards", () => {
  const methods = [pm("pm_1", "fp_a"), pm("pm_2", "fp_b"), pm("pm_3", "fp_a")];
  const groups = groupByFingerprint(methods);
  assert.deepEqual([...groups.keys()].sort(), ["fp_a", "fp_b"]);
  assert.deepEqual(groups.get("fp_a").map((m) => m.id).sort(), ["pm_1", "pm_3"]);
  assert.deepEqual(groups.get("fp_b").map((m) => m.id), ["pm_2"]);
});

test("groupByFingerprint skips methods without one", () => {
  const methods = [{ id: "pm_1", card: {} }, pm("pm_2")];
  const groups = groupByFingerprint(methods);
  assert.deepEqual([...groups.keys()], ["fp_abc"]);
});
