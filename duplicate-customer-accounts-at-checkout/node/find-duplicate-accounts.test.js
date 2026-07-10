import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  pickSurvivor,
  groupByEmail,
  normalizeEmail,
  intentIdOf,
} from "./find-duplicate-accounts.js";

const customer = (id, over = {}) => ({
  id,
  email: "shopper@example.com",
  orders_count: 0,
  date_created: "2026-01-01T00:00:00",
  ...over,
});

const order = (id, intentId = "pi_1") => ({
  id,
  meta_data: [{ key: "_stripe_intent_id", value: intentId }],
  transaction_id: "",
});

function makeGetIntent(customerByIntent) {
  return (intentId) => {
    if (intentId == null || !(intentId in customerByIntent)) return null;
    return { id: intentId, customer: customerByIntent[intentId] };
  };
}

test("skip when only one account", () => {
  const result = decide("a@example.com", [customer(1)], {}, makeGetIntent({}));
  assert.equal(result.action, "skip");
});

test("merge when duplicate has no orders", () => {
  const a = customer(1, { orders_count: 3 });
  const b = customer(2, { orders_count: 0 });
  const ordersByCustomer = { 1: [order(101)], 2: [] };
  const result = decide("a@example.com", [a, b], ordersByCustomer, makeGetIntent({ pi_1: "cus_survivor" }));
  assert.equal(result.action, "merge");
  assert.equal(result.survivor.id, 1);
  assert.deepEqual(result.duplicates.map((d) => d.id), [2]);
});

test("merge when both trace to the same Stripe customer", () => {
  const a = customer(1, { orders_count: 2 });
  const b = customer(2, { orders_count: 1 });
  const ordersByCustomer = { 1: [order(101, "pi_1")], 2: [order(102, "pi_2")] };
  const getIntent = makeGetIntent({ pi_1: "cus_same", pi_2: "cus_same" });
  const result = decide("a@example.com", [a, b], ordersByCustomer, getIntent);
  assert.equal(result.action, "merge");
  assert.equal(result.survivor.id, 1);
});

test("review when Stripe customers differ", () => {
  const a = customer(1, { orders_count: 2 });
  const b = customer(2, { orders_count: 1 });
  const ordersByCustomer = { 1: [order(101, "pi_1")], 2: [order(102, "pi_2")] };
  const getIntent = makeGetIntent({ pi_1: "cus_aaa", pi_2: "cus_bbb" });
  const result = decide("a@example.com", [a, b], ordersByCustomer, getIntent);
  assert.equal(result.action, "review");
});

test("pickSurvivor prefers most orders", () => {
  const a = customer(1, { orders_count: 1, date_created: "2026-01-01T00:00:00" });
  const b = customer(2, { orders_count: 5, date_created: "2026-02-01T00:00:00" });
  assert.equal(pickSurvivor([a, b]).id, 2);
});

test("pickSurvivor tie breaks on earliest created", () => {
  const a = customer(1, { orders_count: 2, date_created: "2026-03-01T00:00:00" });
  const b = customer(2, { orders_count: 2, date_created: "2026-01-01T00:00:00" });
  assert.equal(pickSurvivor([a, b]).id, 2);
});

test("groupByEmail normalizes case and whitespace", () => {
  const customers = [
    customer(1, { email: "Shopper@Example.com " }),
    customer(2, { email: " shopper@example.com" }),
  ];
  const groups = groupByEmail(customers);
  assert.deepEqual(Object.keys(groups), ["shopper@example.com"]);
  assert.equal(groups["shopper@example.com"].length, 2);
});

test("groupByEmail ignores singletons", () => {
  const customers = [customer(1, { email: "a@example.com" }), customer(2, { email: "b@example.com" })];
  assert.deepEqual(groupByEmail(customers), {});
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

test("normalizeEmail handles undefined", () => {
  assert.equal(normalizeEmail(undefined), "");
});
