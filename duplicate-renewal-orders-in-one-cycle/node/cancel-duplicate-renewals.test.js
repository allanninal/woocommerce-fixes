import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, chooseKeeper, renewalKey, groupRenewals } from "./cancel-duplicate-renewals.js";

function makeOrder(id, status, { total = "20.00", subId = "55", renewalDate = "2026-07-01 00:00:00" } = {}) {
  const meta = [];
  if (subId !== null) meta.push({ key: "_subscription_renewal", value: subId });
  if (renewalDate !== null) meta.push({ key: "_subscription_renewal_date", value: renewalDate });
  return { id, status, total, meta_data: meta };
}

test("single order is left alone", () => {
  const results = decide([makeOrder(1, "processing")]);
  assert.equal(results[0].action, "skip");
});

test("keeps paid, cancels unpaid duplicate", () => {
  const paid = makeOrder(1, "processing");
  const unpaid = makeOrder(2, "pending");
  const byId = Object.fromEntries(decide([paid, unpaid]).map((r) => [r.order.id, r.action]));
  assert.equal(byId[1], "keep");
  assert.equal(byId[2], "cancel");
});

test("cancels failed duplicate", () => {
  const paid = makeOrder(1, "processing");
  const failed = makeOrder(2, "failed");
  const byId = Object.fromEntries(decide([paid, failed]).map((r) => [r.order.id, r.action]));
  assert.equal(byId[1], "keep");
  assert.equal(byId[2], "cancel");
});

test("cancels on-hold duplicate", () => {
  const paid = makeOrder(1, "completed");
  const onHold = makeOrder(2, "on-hold");
  const byId = Object.fromEntries(decide([paid, onHold]).map((r) => [r.order.id, r.action]));
  assert.equal(byId[2], "cancel");
});

test("keeps oldest when none are paid", () => {
  const a = makeOrder(5, "pending");
  const b = makeOrder(9, "pending");
  const byId = Object.fromEntries(decide([a, b]).map((r) => [r.order.id, r.action]));
  assert.equal(byId[5], "keep");
  assert.equal(byId[9], "cancel");
});

test("flags two paid orders instead of cancelling", () => {
  const a = makeOrder(3, "processing");
  const b = makeOrder(4, "completed");
  const actions = new Set(decide([a, b]).map((r) => r.action));
  assert.equal(actions.has("cancel"), false);
  assert.equal(actions.has("flag"), true);
  assert.equal(actions.has("keep"), true);
});

test("flags paid order when Stripe says not succeeded", () => {
  const keeper = makeOrder(1, "processing");
  const suspect = makeOrder(2, "completed");
  const intents = new Map([[2, { status: "requires_payment_method" }]]);
  const byId = Object.fromEntries(decide([keeper, suspect], intents).map((r) => [r.order.id, r.action]));
  assert.equal(byId[2], "flag");
});

test("skips refunded duplicate instead of cancelling", () => {
  const paid = makeOrder(1, "processing");
  const refunded = makeOrder(2, "refunded");
  const byId = Object.fromEntries(decide([paid, refunded]).map((r) => [r.order.id, r.action]));
  assert.equal(byId[2], "skip");
});

test("chooseKeeper prefers paid order", () => {
  const paid = makeOrder(9, "processing");
  const unpaid = makeOrder(2, "pending");
  assert.equal(chooseKeeper([unpaid, paid]).id, 9);
});

test("chooseKeeper falls back to oldest id", () => {
  const a = makeOrder(7, "pending");
  const b = makeOrder(3, "pending");
  assert.equal(chooseKeeper([a, b]).id, 3);
});

test("renewalKey requires both meta fields", () => {
  assert.equal(renewalKey(makeOrder(1, "pending", { subId: null })), null);
  assert.equal(renewalKey(makeOrder(1, "pending", { renewalDate: null })), null);
  assert.equal(renewalKey(makeOrder(1, "pending")), "55::2026-07-01 00:00:00");
});

test("groupRenewals groups by subscription and date", () => {
  const a = makeOrder(1, "processing", { subId: "10", renewalDate: "2026-07-01 00:00:00" });
  const b = makeOrder(2, "pending", { subId: "10", renewalDate: "2026-07-01 00:00:00" });
  const c = makeOrder(3, "processing", { subId: "10", renewalDate: "2026-08-01 00:00:00" });
  const groups = groupRenewals([a, b, c]);
  assert.equal(groups.get("10::2026-07-01 00:00:00").length, 2);
  assert.equal(groups.get("10::2026-08-01 00:00:00").length, 1);
});
