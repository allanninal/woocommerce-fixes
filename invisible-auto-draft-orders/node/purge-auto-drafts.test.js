import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, ageHours } from "./purge-auto-drafts.js";

const NOW = Date.parse("2026-07-10T00:00:00Z") / 1000;

const order = (over = {}) => ({
  status: "auto-draft",
  date_created_gmt: "2026-07-08T00:00:00",
  ...over,
});

const intent = (over = {}) => ({ status: "succeeded", ...over });

test("skip when not a draft status", () => {
  assert.equal(decide(order({ status: "pending" }), null, NOW)[0], "skip");
});

test("keep when intent is in progress", () => {
  assert.equal(decide(order(), intent({ status: "requires_action" }), NOW)[0], "keep");
});

test("keep when intent already succeeded", () => {
  assert.equal(decide(order(), intent({ status: "succeeded" }), NOW)[0], "keep");
});

test("keep when draft is young", () => {
  const o = order({ date_created_gmt: "2026-07-09T23:00:00" });
  assert.equal(decide(o, null, NOW, 24)[0], "keep");
});

test("delete when stale and no intent", () => {
  const o = order({ date_created_gmt: "2026-07-01T00:00:00" });
  assert.equal(decide(o, null, NOW, 24)[0], "delete");
});

test("delete when stale and intent abandoned", () => {
  const o = order({ status: "checkout-draft", date_created_gmt: "2026-07-01T00:00:00" });
  assert.equal(decide(o, intent({ status: "canceled" }), NOW, 24)[0], "delete");
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

test("ageHours computed from created date", () => {
  const o = order({ date_created_gmt: "2026-07-09T00:00:00" });
  assert.ok(Math.abs(ageHours(o, NOW) - 24) < 0.01);
});
