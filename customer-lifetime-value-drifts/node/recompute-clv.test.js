import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCustomerClv, decide } from "./recompute-clv.js";

const order = (over = {}) => ({
  id: 1,
  status: "processing",
  total: "50.00",
  total_refunded: "0",
  ...over,
});

test("clv sums paid orders only", () => {
  const orders = [
    order({ id: 1, status: "processing", total: "50.00" }),
    order({ id: 2, status: "pending", total: "999.00" }),
    order({ id: 3, status: "completed", total: "20.00" }),
  ];
  const { totalMinor, counted, notes } = computeCustomerClv(orders);
  assert.equal(totalMinor, 7000);
  assert.equal(counted, 2);
  assert.deepEqual(notes, []);
});

test("clv nets out woo refund", () => {
  const orders = [order({ id: 1, status: "processing", total: "50.00", total_refunded: "20.00" })];
  const { totalMinor, counted } = computeCustomerClv(orders);
  assert.equal(totalMinor, 3000);
  assert.equal(counted, 1);
});

test("clv prefers larger stripe refund over stale woo cache", () => {
  const orders = [order({ id: 1, status: "processing", total: "50.00", total_refunded: "0" })];
  const { totalMinor, notes } = computeCustomerClv(orders, { 1: 5000 });
  assert.equal(totalMinor, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /order 1/);
});

test("clv never goes negative on over refund data glitch", () => {
  const orders = [order({ id: 1, status: "processing", total: "50.00", total_refunded: "0" })];
  const { totalMinor } = computeCustomerClv(orders, { 1: 999999 });
  assert.equal(totalMinor, 0);
});

test("decide ok when cache matches", () => {
  assert.equal(decide({ total_spent: "70.00" }, 7000)[0], "ok");
});

test("decide drift when cache is stale high", () => {
  const [action, reason] = decide({ total_spent: "120.00" }, 7000);
  assert.equal(action, "drift");
  assert.match(reason, /higher/);
});

test("decide drift when cache is stale low", () => {
  const [action, reason] = decide({ total_spent: "30.00" }, 7000);
  assert.equal(action, "drift");
  assert.match(reason, /lower/);
});

test("decide no_orders when both zero", () => {
  assert.equal(decide({ total_spent: "0" }, 0)[0], "no_orders");
});

test("decide respects tolerance", () => {
  assert.equal(decide({ total_spent: "50.00" }, 5001, 5)[0], "ok");
});
