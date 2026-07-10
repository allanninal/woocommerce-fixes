import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, advance } from "./fix-past-next-payment.js";

const NOW = Date.parse("2026-07-10T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const sub = (over = {}) => ({
  status: "active",
  next_payment: NOW - 10 * DAY_MS,
  billing_period: "month",
  billing_interval: 1,
  ...over,
});

test("reschedule when active and past due", () => {
  const [action, , fixed] = decide(sub(), NOW);
  assert.equal(action, "reschedule");
  assert.ok(fixed > NOW);
});

test("skip when not active", () => {
  const [action, , fixed] = decide(sub({ status: "on-hold" }), NOW);
  assert.equal(action, "skip");
  assert.equal(fixed, null);
});

test("skip when cancelled", () => {
  const [action] = decide(sub({ status: "cancelled" }), NOW);
  assert.equal(action, "skip");
});

test("skip when next payment in future", () => {
  const [action] = decide(sub({ next_payment: NOW + 5 * DAY_MS }), NOW);
  assert.equal(action, "skip");
});

test("skip when next payment missing", () => {
  const [action] = decide(sub({ next_payment: null }), NOW);
  assert.equal(action, "skip");
});

test("skip when renewal in progress", () => {
  const [action, reason, fixed] = decide(sub(), NOW, true);
  assert.equal(action, "skip");
  assert.match(reason, /in progress/);
  assert.equal(fixed, null);
});

test("skip when billing schedule unknown", () => {
  const [action] = decide(sub({ billing_period: "fortnight" }), NOW);
  assert.equal(action, "skip");
});

test("advance steps by whole periods", () => {
  const old = NOW - 95 * DAY_MS; // about 3 monthly periods behind
  const fixed = advance(old, "month", 1, NOW);
  assert.ok(fixed > NOW);
  assert.equal((fixed - old) % (30 * DAY_MS), 0);
});

test("advance respects multi-month interval", () => {
  const old = NOW - 200 * DAY_MS;
  const fixed = advance(old, "month", 3, NOW);
  assert.ok(fixed > NOW);
  assert.equal((fixed - old) % (90 * DAY_MS), 0);
});

test("advance returns unchanged when already future", () => {
  const future = NOW + 5 * DAY_MS;
  assert.equal(advance(future, "month", 1, NOW), future);
});

test("advance weekly period", () => {
  const old = NOW - 22 * DAY_MS; // a bit more than 3 weeks behind
  const fixed = advance(old, "week", 1, NOW);
  assert.ok(fixed > NOW);
  assert.equal((fixed - old) % (7 * DAY_MS), 0);
});
