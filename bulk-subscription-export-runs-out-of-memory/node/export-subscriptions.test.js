import { test } from "node:test";
import assert from "node:assert/strict";
import { planNextPage, nextPageSize, bytesPerRowEstimate, toRow } from "./export-subscriptions.js";

const state = (over = {}) => ({
  pageSize: 100,
  rowsInLastPage: 0,
  lastPageBytes: 0,
  totalRowsSoFar: 0,
  maxRows: null,
  memoryBudgetMb: 150,
  hasFetchedAPage: false,
  ...over,
});

test("continue on the first request", () => {
  assert.equal(planNextPage(state())[0], "continue");
});

test("continue when page fits comfortably in budget", () => {
  const s = state({ rowsInLastPage: 100, lastPageBytes: 200_000, hasFetchedAPage: true });
  assert.equal(planNextPage(s)[0], "continue");
});

test("stop_done when a page returns no rows", () => {
  const s = state({ rowsInLastPage: 0, hasFetchedAPage: true });
  assert.equal(planNextPage(s)[0], "stop_done");
});

test("stop_done when row cap reached", () => {
  const s = state({ totalRowsSoFar: 500, maxRows: 500 });
  assert.equal(planNextPage(s)[0], "stop_done");
});

test("shrink when last page blew the memory budget", () => {
  const hugeBytes = 300 * 1024 * 1024; // 300MB, over the 150MB budget
  const s = state({ pageSize: 100, rowsInLastPage: 100, lastPageBytes: hugeBytes, hasFetchedAPage: true });
  assert.equal(planNextPage(s)[0], "shrink");
});

test("no shrink below the minimum page size", () => {
  const hugeBytes = 300 * 1024 * 1024;
  const s = state({ pageSize: 10, rowsInLastPage: 10, lastPageBytes: hugeBytes, hasFetchedAPage: true });
  // Already at MIN_PAGE_SIZE (10), so we keep going rather than shrink forever.
  assert.equal(planNextPage(s)[0], "continue");
});

test("nextPageSize halves", () => {
  assert.equal(nextPageSize(100), 50);
});

test("nextPageSize never below minimum", () => {
  assert.equal(nextPageSize(12), 10); // MIN_PAGE_SIZE is 10
  assert.equal(nextPageSize(4), 10);
});

test("bytesPerRowEstimate normal", () => {
  assert.equal(bytesPerRowEstimate(1000, 100), 10);
});

test("bytesPerRowEstimate zero rows is zero", () => {
  assert.equal(bytesPerRowEstimate(1000, 0), 0);
});

test("toRow keeps only known fields with fallback empty string", () => {
  const row = toRow({ id: 42, status: "active", total: "19.99", extra_field: "ignored" });
  assert.equal(row.id, 42);
  assert.equal(row.status, "active");
  assert.equal(row.customer_id, "");
  assert.equal(row.extra_field, undefined);
});
