import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, pausedByHost, intentIdOf } from "./restore-wrongly-paused-subs.js";

const LIVE_HOST = "shop.example.com";

const sub = (over = {}) => ({
  status: "on-hold",
  meta_data: [{ key: "_paused_by_host", value: "staging.example.com" }],
  ...over,
});

const invoice = (over = {}) => ({ status: "paid", ...over });

test("restore when paused by staging and invoice paid", () => {
  assert.equal(decide(sub(), invoice(), LIVE_HOST)[0], "restore");
});

test("skip when not on-hold", () => {
  assert.equal(decide(sub({ status: "active" }), invoice(), LIVE_HOST)[0], "skip");
});

test("skip when no host recorded", () => {
  assert.equal(decide(sub({ meta_data: [] }), invoice(), LIVE_HOST)[0], "skip");
});

test("skip when paused by the live site", () => {
  const s = sub({ meta_data: [{ key: "_paused_by_host", value: LIVE_HOST }] });
  assert.equal(decide(s, invoice(), LIVE_HOST)[0], "skip");
});

test("hold when no invoice found", () => {
  assert.equal(decide(sub(), null, LIVE_HOST)[0], "hold");
});

test("hold when invoice not paid", () => {
  assert.equal(decide(sub(), invoice({ status: "open" }), LIVE_HOST)[0], "hold");
});

test("pausedByHost reads meta", () => {
  assert.equal(pausedByHost(sub()), "staging.example.com");
});

test("pausedByHost missing is null", () => {
  assert.equal(pausedByHost({ meta_data: [] }), null);
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
