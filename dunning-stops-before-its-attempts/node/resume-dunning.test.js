import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  intentIdOf,
  dunningAttemptCount,
  hoursSinceLastAttempt,
} from "./resume-dunning.js";

const NOW = 1_800_000_000;
const DAY = 86400;

const sub = (over = {}) => ({
  status: "on-hold",
  meta_data: [
    { key: "_dunning_attempt_count", value: "1" },
    { key: "_dunning_last_attempt_ts", value: String(NOW - 2 * DAY) },
  ],
  ...over,
});

const order = (over = {}) => ({ status: "on-hold", total: "50.00", ...over });

test("resume when stalled with attempts left", () => {
  assert.equal(decide(sub(), order(), NOW)[0], "resume");
});

test("wait when inside the normal window", () => {
  const recent = sub({
    meta_data: [
      { key: "_dunning_attempt_count", value: "1" },
      { key: "_dunning_last_attempt_ts", value: String(NOW - 3600) },
    ],
  });
  assert.equal(decide(recent, order(), NOW)[0], "wait");
});

test("exhausted when every attempt ran", () => {
  const maxed = sub({
    meta_data: [
      { key: "_dunning_attempt_count", value: "3" },
      { key: "_dunning_last_attempt_ts", value: String(NOW - 5 * DAY) },
    ],
  });
  assert.equal(decide(maxed, order(), NOW)[0], "exhausted");
});

test("skip when subscription not on-hold", () => {
  assert.equal(decide(sub({ status: "active" }), order(), NOW)[0], "skip");
});

test("skip when no renewal order", () => {
  assert.equal(decide(sub(), null, NOW)[0], "skip");
});

test("resume when never recorded before", () => {
  assert.equal(decide(sub({ meta_data: [] }), order(), NOW)[0], "resume");
});

test("dunningAttemptCount reads meta", () => {
  assert.equal(dunningAttemptCount(sub()), 1);
});

test("dunningAttemptCount defaults to zero", () => {
  assert.equal(dunningAttemptCount(sub({ meta_data: [] })), 0);
});

test("hoursSinceLastAttempt computes delta", () => {
  const hours = hoursSinceLastAttempt(sub(), NOW);
  assert.ok(hours > 47.9 && hours < 48.1);
});

test("hoursSinceLastAttempt null when missing", () => {
  assert.equal(hoursSinceLastAttempt(sub({ meta_data: [] }), NOW), null);
});

test("intentIdOf from meta", () => {
  assert.equal(
    intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }),
    "pi_123"
  );
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});
