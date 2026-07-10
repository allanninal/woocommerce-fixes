import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, parseGmt, intentIdOf } from "./expire-overdue-subscriptions.js";

const NOW = new Date("2026-07-10T12:00:00Z");

const sub = (over = {}) => ({ status: "active", end_date_gmt: "2026-07-01 00:00:00", ...over });

test("expire when end date passed and open", () => {
  assert.equal(decide(sub(), NOW)[0], "expire");
});

test("skip when no end date", () => {
  assert.equal(decide(sub({ end_date_gmt: "0000-00-00 00:00:00" }), NOW)[0], "skip");
});

test("skip when end date missing key", () => {
  assert.equal(decide({ status: "active" }, NOW)[0], "skip");
});

test("skip when end date in future", () => {
  assert.equal(decide(sub({ end_date_gmt: "2026-08-01 00:00:00" }), NOW)[0], "skip");
});

test("skip when already expired", () => {
  assert.equal(decide(sub({ status: "expired" }), NOW)[0], "skip");
});

test("skip when cancelled", () => {
  assert.equal(decide(sub({ status: "cancelled" }), NOW)[0], "skip");
});

test("wait inside grace window", () => {
  const recent = sub({ end_date_gmt: "2026-07-10 08:00:00" }); // 4 hours ago, inside 6h grace
  assert.equal(decide(recent, NOW)[0], "wait");
});

test("expire past grace window", () => {
  const old = sub({ end_date_gmt: "2026-07-10 04:00:00" }); // 8 hours ago, past 6h grace
  assert.equal(decide(old, NOW)[0], "expire");
});

test("pending-cancel counts as open", () => {
  assert.equal(decide(sub({ status: "pending-cancel" }), NOW)[0], "expire");
});

test("parseGmt handles iso T and Z", () => {
  assert.equal(parseGmt("2026-07-01T00:00:00Z").getTime(), new Date("2026-07-01T00:00:00Z").getTime());
});

test("parseGmt null for zero date", () => {
  assert.equal(parseGmt("0000-00-00 00:00:00"), null);
});

test("parseGmt null for empty", () => {
  assert.equal(parseGmt(""), null);
  assert.equal(parseGmt(null), null);
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
