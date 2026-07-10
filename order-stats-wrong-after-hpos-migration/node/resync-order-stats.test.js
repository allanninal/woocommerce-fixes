import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, orderAmountMinor, reportAmountMinor } from "./resync-order-stats.js";

const order = (over = {}) => ({ id: 501, status: "processing", total: "50.00", ...over });
const reportRow = (over = {}) => ({ order_id: 501, status: "processing", total_sales: "50.00", ...over });

test("ok when row matches order", () => {
  assert.equal(decide(order(), reportRow())[0], "ok");
});

test("missing when no stats row for countable order", () => {
  assert.equal(decide(order(), null)[0], "missing");
});

test("resync when status is stale", () => {
  assert.equal(decide(order({ status: "completed" }), reportRow({ status: "processing" }))[0], "resync");
});

test("resync when total mismatches", () => {
  assert.equal(decide(order({ total: "80.00" }), reportRow({ total_sales: "50.00" }))[0], "resync");
});

test("skip when status not counted", () => {
  assert.equal(decide(order({ status: "pending" }), null)[0], "skip");
});

test("skip when cancelled even with a stale row", () => {
  assert.equal(decide(order({ status: "cancelled" }), reportRow())[0], "skip");
});

test("orderAmountMinor rounds to cents", () => {
  assert.equal(orderAmountMinor({ total: "19.999" }), 2000);
});

test("reportAmountMinor defaults to zero", () => {
  assert.equal(reportAmountMinor({}), 0);
});

test("ok tolerates a half cent rounding gap", () => {
  assert.equal(decide(order({ total: "50.00" }), reportRow({ total_sales: "50.01" }))[0], "ok");
});
