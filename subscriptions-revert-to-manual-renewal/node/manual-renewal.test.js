import { test } from "node:test";
import assert from "node:assert/strict";
import { isWronglyManual, hasSavedToken } from "./restore-auto-renewal.js";

const sub = (over = {}) => ({
  status: "active",
  requires_manual_renewal: true,
  meta_data: [{ key: "_stripe_source_id", value: "src_123" }],
  ...over,
});

test("has token from source id", () => {
  assert.equal(hasSavedToken(sub()), true);
});

test("has token from customer id", () => {
  assert.equal(hasSavedToken(sub({ meta_data: [{ key: "_stripe_customer_id", value: "cus_1" }] })), true);
});

test("no token when meta empty", () => {
  assert.equal(hasSavedToken(sub({ meta_data: [] })), false);
});

test("wrongly manual when active, manual, and tokened", () => {
  assert.equal(isWronglyManual(sub()), true);
});

test("not flagged when already automatic", () => {
  assert.equal(isWronglyManual(sub({ requires_manual_renewal: false })), false);
});

test("not flagged when no token", () => {
  assert.equal(isWronglyManual(sub({ meta_data: [] })), false);
});

test("not flagged when not active", () => {
  assert.equal(isWronglyManual(sub({ status: "on-hold" })), false);
});

test("no token when value is empty string", () => {
  assert.equal(hasSavedToken(sub({ meta_data: [{ key: "_stripe_source_id", value: "" }] })), false);
});
