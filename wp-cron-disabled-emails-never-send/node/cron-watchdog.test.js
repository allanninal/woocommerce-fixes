import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, storeVerdict, intentIdOf, hasEmailNote, minutesWaiting } from "./cron-watchdog.js";

const NOW = new Date("2026-07-10T12:00:00Z");

function order(createdMinutesAgo, over = {}) {
  const created = new Date(NOW.getTime() - createdMinutesAgo * 60000);
  return { id: 1, date_created_gmt: created.toISOString(), ...over };
}

test("ok when email note present", () => {
  const notes = [{ note: "Order status changed from processing to completed." }];
  assert.equal(decide(order(60), notes, NOW, 30)[0], "ok");
});

test("wait when inside grace window", () => {
  assert.equal(decide(order(10), [], NOW, 30)[0], "wait");
});

test("stuck when past threshold with no note", () => {
  assert.equal(decide(order(90), [], NOW, 30)[0], "stuck");
});

test("stuck reason includes minutes waited", () => {
  const [action, reason] = decide(order(90), [], NOW, 30);
  assert.equal(action, "stuck");
  assert.match(reason, /90/);
});

test("customer note flag counts as ok", () => {
  const notes = [{ note: "Thanks!", customer_note: true }];
  assert.equal(decide(order(90), notes, NOW, 30)[0], "ok");
});

test("exactly at threshold counts as stuck", () => {
  assert.equal(decide(order(30), [], NOW, 30)[0], "stuck");
});

test("hasEmailNote matches any marker", () => {
  assert.equal(hasEmailNote([{ note: "A note sent to customer about their order." }]), true);
  assert.equal(hasEmailNote([{ note: "Payment via card." }]), false);
  assert.equal(hasEmailNote([]), false);
});

test("minutesWaiting handles missing Z suffix", () => {
  const o = { date_created_gmt: "2026-07-10T11:00:00" };
  assert.ok(Math.abs(minutesWaiting(o, NOW) - 60) < 0.01);
});

test("verdict alarm at threshold", () => {
  assert.equal(storeVerdict(3)[0], "alarm");
});

test("verdict alarm above threshold", () => {
  assert.equal(storeVerdict(10)[0], "alarm");
});

test("verdict watch below threshold", () => {
  assert.equal(storeVerdict(1)[0], "watch");
});

test("verdict healthy when zero", () => {
  assert.equal(storeVerdict(0)[0], "healthy");
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
