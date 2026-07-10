import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRealSubscriber,
  recount,
  decide,
  intentIdOf,
  stripeStatusAgrees,
} from "./recount-active-subscribers.js";

const sub = (over = {}) => ({ status: "active", ...over });

test("active status counts", () => {
  assert.equal(isRealSubscriber(sub({ status: "active" })), true);
});

test("pending-cancel still counts", () => {
  assert.equal(isRealSubscriber(sub({ status: "pending-cancel" })), true);
});

test("cancelled does not count", () => {
  assert.equal(isRealSubscriber(sub({ status: "cancelled" })), false);
});

test("on-hold does not count", () => {
  assert.equal(isRealSubscriber(sub({ status: "on-hold" })), false);
});

test("trial not converted does not count", () => {
  assert.equal(
    isRealSubscriber(sub({ status: "active", trial_end: 1000, has_converted_from_trial: false })),
    false
  );
});

test("trial converted counts", () => {
  assert.equal(
    isRealSubscriber(sub({ status: "active", trial_end: 1000, has_converted_from_trial: true })),
    true
  );
});

test("past end date does not count", () => {
  assert.equal(isRealSubscriber(sub({ status: "active", end_date: 100, _now: 200 })), false);
});

test("recount counts only real subscribers", () => {
  const subs = [
    sub({ status: "active" }),
    sub({ status: "pending-cancel" }),
    sub({ status: "cancelled" }),
    sub({ status: "on-hold" }),
    sub({ status: "active" }),
  ];
  assert.equal(recount(subs), 3);
});

test("decide ok when counts match", () => {
  const [action, , diff] = decide(10, 10);
  assert.equal(action, "ok");
  assert.equal(diff, 0);
});

test("decide small drift is auto repairable", () => {
  const [action, , diff] = decide(10, 11);
  assert.equal(action, "drift");
  assert.equal(diff, 1);
});

test("decide large drift needs review", () => {
  const [action, , diff] = decide(10, 25);
  assert.equal(action, "drift-large");
  assert.equal(diff, 15);
});

test("decide handles cached over count too", () => {
  const [action, , diff] = decide(50, 30);
  assert.equal(action, "drift-large");
  assert.equal(diff, -20);
});

test("intentIdOf from meta", () => {
  assert.equal(
    intentIdOf({ meta_data: [{ key: "_stripe_subscription_id", value: "sub_123" }], transaction_id: "" }),
    "sub_123"
  );
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is unrelated", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("stripeStatusAgrees when both active", () => {
  assert.equal(stripeStatusAgrees(sub({ status: "active" }), { status: "active" }), true);
});

test("stripeStatusAgrees disagrees when stripe cancelled", () => {
  assert.equal(stripeStatusAgrees(sub({ status: "active" }), { status: "canceled" }), false);
});

test("stripeStatusAgrees is null when no stripe object", () => {
  assert.equal(stripeStatusAgrees(sub({ status: "active" }), null), null);
});
