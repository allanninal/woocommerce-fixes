import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./promote-default-source.js";

const pm = (over = {}) => ({
  id: "pm_1",
  card: { fingerprint: "fp_abc" },
  created: 100,
  ...over,
});

test("promote when source matches a payment method", () => {
  const [action, payload] = decide("src_1", "fp_abc", [pm()]);
  assert.equal(action, "promote");
  assert.equal(payload, "pm_1");
});

test("skip when already a payment method", () => {
  const [action] = decide("pm_1", "fp_abc", [pm()]);
  assert.equal(action, "skip");
});

test("skip when default is neither source nor payment method", () => {
  const [action] = decide("ba_1", "fp_abc", [pm()]);
  assert.equal(action, "skip");
});

test("no_match when fingerprint differs", () => {
  const [action] = decide("src_1", "fp_xyz", [pm({ card: { fingerprint: "fp_abc" } })]);
  assert.equal(action, "no_match");
});

test("no_match when no payment methods at all", () => {
  const [action] = decide("src_1", "fp_abc", []);
  assert.equal(action, "no_match");
});

test("no_default when customer has nothing set", () => {
  const [action] = decide(null, null, []);
  assert.equal(action, "no_default");
});

test("no_match when fingerprint is null even with methods present", () => {
  const [action] = decide("src_1", null, [pm({ card: { fingerprint: null } })]);
  assert.equal(action, "no_match");
});

test("promote prefers most recently created match", () => {
  const older = pm({ id: "pm_old", created: 100 });
  const newer = pm({ id: "pm_new", created: 200 });
  const [action, payload] = decide("src_1", "fp_abc", [older, newer]);
  assert.equal(action, "promote");
  assert.equal(payload, "pm_new");
});
