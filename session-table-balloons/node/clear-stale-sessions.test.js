import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, sessionsTableSizeMb } from "./clear-stale-sessions.js";

test("skip when under threshold", () => {
  assert.equal(decide(10.0, 50.0, 0)[0], "skip");
});

test("clear when over threshold and no open checkout", () => {
  assert.equal(decide(120.0, 50.0, 0)[0], "clear");
});

test("wait when over threshold but checkout in progress", () => {
  assert.equal(decide(120.0, 50.0, 2)[0], "wait");
});

test("skip takes priority even with open checkout", () => {
  assert.equal(decide(5.0, 50.0, 3)[0], "skip");
});

test("boundary meets threshold counts as bloated", () => {
  assert.equal(decide(50.0, 50.0, 0)[0], "clear");
});

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("sessionsTableSizeMb sums data and index", () => {
  const status = { database: { database_tables: { other: {
    woocommerce_sessions: { data: "4.10", index: "0.15" },
  } } } };
  assert.ok(Math.abs(sessionsTableSizeMb(status) - 4.25) < 1e-9);
});

test("sessionsTableSizeMb missing table is zero", () => {
  const status = { database: { database_tables: { other: {} } } };
  assert.equal(sessionsTableSizeMb(status), 0);
});
