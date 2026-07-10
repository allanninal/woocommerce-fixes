import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, pickSurvivor, groupByEmail, orderAmountMinor } from "./merge-duplicate-customers.js";

const cust = (id, created, { orderCount = 0, hasSubscription = false, email = "shopper@example.com" } = {}) => ({
  id,
  email,
  created,
  order_count: orderCount,
  has_subscription: hasSubscription,
});

test("pickSurvivor prefers active subscription", () => {
  const a = cust("cus_a", 100, { orderCount: 5 });
  const b = cust("cus_b", 200, { orderCount: 1, hasSubscription: true });
  const { survivor, duplicates } = pickSurvivor([a, b]);
  assert.equal(survivor.id, "cus_b");
  assert.deepEqual(duplicates, [a]);
});

test("pickSurvivor prefers most orders when no subscription", () => {
  const a = cust("cus_a", 100, { orderCount: 1 });
  const b = cust("cus_b", 200, { orderCount: 9 });
  const { survivor, duplicates } = pickSurvivor([a, b]);
  assert.equal(survivor.id, "cus_b");
  assert.deepEqual(duplicates, [a]);
});

test("pickSurvivor ties go to oldest", () => {
  const a = cust("cus_a", 100, { orderCount: 3 });
  const b = cust("cus_b", 200, { orderCount: 3 });
  const { survivor } = pickSurvivor([a, b]);
  assert.equal(survivor.id, "cus_a");
});

test("pickSurvivor single customer is a no-op", () => {
  const a = cust("cus_a", 100, { orderCount: 3 });
  const { survivor, duplicates } = pickSurvivor([a]);
  assert.equal(survivor.id, "cus_a");
  assert.deepEqual(duplicates, []);
});

test("pickSurvivor empty list", () => {
  const { survivor, duplicates } = pickSurvivor([]);
  assert.equal(survivor, null);
  assert.deepEqual(duplicates, []);
});

test("decide skips single customer", () => {
  const a = cust("cus_a", 100, { orderCount: 3 });
  const plan = decide("shopper@example.com", [a]);
  assert.equal(plan.action, "skip");
});

test("decide merges multiple customers", () => {
  const a = cust("cus_a", 100, { orderCount: 1 });
  const b = cust("cus_b", 200, { orderCount: 9 });
  const plan = decide("shopper@example.com", [a, b]);
  assert.equal(plan.action, "merge");
  assert.equal(plan.survivor.id, "cus_b");
  assert.deepEqual(plan.duplicates, [a]);
});

test("decide skips when no customers at all", () => {
  const plan = decide("nobody@example.com", []);
  assert.equal(plan.action, "skip");
  assert.equal(plan.survivor, null);
});

test("groupByEmail normalizes case and whitespace", () => {
  const customers = [
    cust("cus_a", 100, { email: " Shopper@Example.com " }),
    cust("cus_b", 200, { email: "shopper@example.com" }),
    cust("cus_c", 300, { email: "other@example.com" }),
  ];
  const groups = groupByEmail(customers);
  assert.deepEqual(Object.keys(groups).sort(), ["other@example.com", "shopper@example.com"]);
  assert.equal(groups["shopper@example.com"].length, 2);
});

test("groupByEmail drops customers with no email", () => {
  const customers = [cust("cus_a", 100, { email: "" }), cust("cus_b", 200, { email: null })];
  const groups = groupByEmail(customers);
  assert.deepEqual(groups, {});
});

test("orderAmountMinor converts to cents", () => {
  assert.equal(orderAmountMinor({ total: "49.99" }), 4999);
  assert.equal(orderAmountMinor({ total: "10" }), 1000);
});
