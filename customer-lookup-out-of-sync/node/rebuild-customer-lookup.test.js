import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  recalcFromOrders,
  storedTotalsOf,
  stripeCustomerIdOf,
} from "./rebuild-customer-lookup.js";

const order = (over = {}) => ({ total: "50.00", date_created: "2026-06-01T10:00:00", ...over });

test("skip when stored matches real orders", () => {
  const recalculated = recalcFromOrders([order()]);
  const stored = { ordersCount: 1, totalSpentMinor: 5000, lastOrderDate: "2026-06-01T10:00:00" };
  assert.equal(decide(stored, recalculated)[0], "skip");
});

test("rebuild when count differs", () => {
  const recalculated = recalcFromOrders([order(), order({ total: "30.00", date_created: "2026-06-05T10:00:00" })]);
  const stored = { ordersCount: 1, totalSpentMinor: 5000, lastOrderDate: "2026-06-01T10:00:00" };
  assert.equal(decide(stored, recalculated)[0], "rebuild");
});

test("rebuild when total differs by more than a cent", () => {
  const recalculated = recalcFromOrders([order({ total: "50.00" })]);
  const stored = { ordersCount: 1, totalSpentMinor: 4000, lastOrderDate: "2026-06-01T10:00:00" };
  assert.equal(decide(stored, recalculated)[0], "rebuild");
});

test("skip when total differs by rounding only", () => {
  const recalculated = recalcFromOrders([order({ total: "50.00" })]);
  const stored = { ordersCount: 1, totalSpentMinor: 5001, lastOrderDate: "2026-06-01T10:00:00" };
  assert.equal(decide(stored, recalculated)[0], "skip");
});

test("rebuild when no real orders but stored has some", () => {
  const recalculated = recalcFromOrders([]);
  const stored = { ordersCount: 3, totalSpentMinor: 15000, lastOrderDate: "2026-05-01T10:00:00" };
  const [action, reason] = decide(stored, recalculated);
  assert.equal(action, "rebuild");
  assert.match(reason, /no real paid orders/);
});

test("rebuild when last order date differs", () => {
  const recalculated = recalcFromOrders([order({ date_created: "2026-06-10T10:00:00" })]);
  const stored = { ordersCount: 1, totalSpentMinor: 5000, lastOrderDate: "2026-06-01T10:00:00" };
  assert.equal(decide(stored, recalculated)[0], "rebuild");
});

test("recalc totals and last order date", () => {
  const recalculated = recalcFromOrders([
    order({ total: "20.00", date_created: "2026-06-01T10:00:00" }),
    order({ total: "30.00", date_created: "2026-06-10T10:00:00" }),
  ]);
  assert.equal(recalculated.ordersCount, 2);
  assert.equal(recalculated.totalSpentMinor, 5000);
  assert.equal(recalculated.lastOrderDate, "2026-06-10T10:00:00");
});

test("recalc with no orders", () => {
  const recalculated = recalcFromOrders([]);
  assert.deepEqual(recalculated, { ordersCount: 0, totalSpentMinor: 0, lastOrderDate: null });
});

test("storedTotalsOf normalizes customer record", () => {
  const customer = { orders_count: 4, total_spent: "120.50", last_order_date: "2026-06-01T10:00:00" };
  assert.deepEqual(storedTotalsOf(customer), {
    ordersCount: 4,
    totalSpentMinor: 12050,
    lastOrderDate: "2026-06-01T10:00:00",
  });
});

test("storedTotalsOf handles empty total_spent", () => {
  const customer = { orders_count: 0, total_spent: "", last_order_date: null };
  assert.deepEqual(storedTotalsOf(customer), { ordersCount: 0, totalSpentMinor: 0, lastOrderDate: null });
});

test("stripeCustomerIdOf from meta", () => {
  const o = order({ meta_data: [{ key: "_stripe_customer_id", value: "cus_123" }], transaction_id: "" });
  assert.equal(stripeCustomerIdOf(o), "cus_123");
});

test("stripeCustomerIdOf falls back to transaction_id", () => {
  const o = order({ meta_data: [], transaction_id: "cus_456" });
  assert.equal(stripeCustomerIdOf(o), "cus_456");
});

test("stripeCustomerIdOf null when transaction is not a customer id", () => {
  const o = order({ meta_data: [], transaction_id: "pi_789" });
  assert.equal(stripeCustomerIdOf(o), null);
});
