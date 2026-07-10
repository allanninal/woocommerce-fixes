import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, hasCategory, intentIdOf } from "./assign-fallback-category.js";

const product = (over = {}) => ({
  id: 42, name: "Ceramic Mug", status: "publish", categories: [], ...over,
});

test("fix when no category and config present", () => {
  assert.equal(decide(product(), 99, false)[0], "fix");
});

test("fix reason mentions sales when recently sold", () => {
  const [action, reason] = decide(product(), 99, true);
  assert.equal(action, "fix");
  assert.match(reason, /recent sales/);
});

test("skip when product already has a category", () => {
  const p = product({ categories: [{ id: 12, name: "Mugs" }] });
  assert.equal(decide(p, 99, false)[0], "skip");
});

test("skip when not published", () => {
  assert.equal(decide(product({ status: "draft" }), 99, false)[0], "skip");
});

test("blocked when no fallback category configured", () => {
  const [action, reason] = decide(product(), 0, false);
  assert.equal(action, "blocked");
  assert.match(reason, /FALLBACK_CATEGORY_ID/);
});

test("hasCategory true with categories", () => {
  assert.equal(hasCategory(product({ categories: [{ id: 1, name: "Mugs" }] })), true);
});

test("hasCategory false when empty", () => {
  assert.equal(hasCategory(product({ categories: [] })), false);
});

test("intentIdOf from meta", () => {
  const order = { meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" };
  assert.equal(intentIdOf(order), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  const order = { meta_data: [], transaction_id: "pi_456" };
  assert.equal(intentIdOf(order), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  const order = { meta_data: [], transaction_id: "ch_789" };
  assert.equal(intentIdOf(order), null);
});
