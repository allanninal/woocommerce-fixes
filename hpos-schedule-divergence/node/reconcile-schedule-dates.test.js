import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, hposNextPaymentTs, metaNextPaymentTs } from "./reconcile-schedule-dates.js";

const subscription = (over = {}) => ({
  status: "active",
  schedule_next_payment: "2026-08-10T00:00:00",
  meta_data: [{ key: "_schedule_next_payment", value: "2026-08-10T00:00:00" }],
  ...over,
});

test("ok when hpos and meta agree and schedule is ahead", () => {
  const sub = subscription();
  const lastChargeTs = hposNextPaymentTs(sub) - 30 * 86400;
  assert.equal(decide(sub, lastChargeTs)[0], "ok");
});

test("skip when subscription not active", () => {
  const sub = subscription({ status: "cancelled" });
  assert.equal(decide(sub, null)[0], "skip");
});

test("skip when no hpos schedule date", () => {
  const sub = subscription({ schedule_next_payment: null });
  assert.equal(decide(sub, null)[0], "skip");
});

test("diverged when hpos and meta disagree", () => {
  const sub = subscription({
    schedule_next_payment: "2026-08-10T00:00:00",
    meta_data: [{ key: "_schedule_next_payment", value: "2026-07-01T00:00:00" }],
  });
  assert.equal(decide(sub, null)[0], "diverged");
});

test("ok when drift is within tolerance", () => {
  const sub = subscription({
    schedule_next_payment: "2026-08-10T00:00:00",
    meta_data: [{ key: "_schedule_next_payment", value: "2026-08-10T00:05:00" }],
  });
  const lastChargeTs = hposNextPaymentTs(sub) - 30 * 86400;
  assert.equal(decide(sub, lastChargeTs)[0], "ok");
});

test("stale when schedule is not after last charge", () => {
  const sub = subscription();
  const lastChargeTs = hposNextPaymentTs(sub) + 3600;
  assert.equal(decide(sub, lastChargeTs)[0], "stale");
});

test("stale when schedule equals last charge", () => {
  const sub = subscription();
  const lastChargeTs = hposNextPaymentTs(sub);
  assert.equal(decide(sub, lastChargeTs)[0], "stale");
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

test("metaNextPaymentTs returns null when missing", () => {
  const sub = subscription({ meta_data: [] });
  assert.equal(metaNextPaymentTs(sub), null);
});

test("hposNextPaymentTs parses iso datetime", () => {
  const sub = subscription({ schedule_next_payment: "2026-08-10T00:00:00" });
  assert.equal(hposNextPaymentTs(sub), 1786320000);
});
