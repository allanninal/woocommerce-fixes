import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, legacyPostIdOf, intentIdOf } from "./find-legacy-order-rows.js";

const order = (over = {}) => ({
  id: 501,
  status: "completed",
  total: "50.00",
  meta_data: [{ key: "_legacy_order_id", value: "9001" }],
  ...over,
});

const legacyPost = (over = {}) => ({ id: 9001, post_type: "shop_order", ...over });

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });

test("report when settled and legacy row present", () => {
  assert.equal(decide(order(), legacyPost(), intent())[0], "report");
});

test("report when no stripe intent at all", () => {
  assert.equal(decide(order(), legacyPost(), null)[0], "report");
});

test("clean when legacy row already gone", () => {
  assert.equal(decide(order(), null, intent())[0], "clean");
});

test("skip when order has no legacy id", () => {
  assert.equal(decide(order({ meta_data: [] }), legacyPost(), intent())[0], "skip");
});

test("skip when order still open", () => {
  assert.equal(decide(order({ status: "processing" }), legacyPost(), intent())[0], "skip");
});

test("skip when stripe payment still in progress", () => {
  assert.equal(decide(order(), legacyPost(), intent({ status: "requires_action" }))[0], "skip");
});

test("skip when post id was reused by other content", () => {
  assert.equal(decide(order(), legacyPost({ post_type: "page" }), intent())[0], "skip");
});

test("mismatch when amount disagrees", () => {
  assert.equal(decide(order({ total: "80.00" }), legacyPost(), intent())[0], "mismatch");
});

test("legacyPostIdOf reads meta", () => {
  assert.equal(legacyPostIdOf(order()), 9001);
});

test("legacyPostIdOf null when missing", () => {
  assert.equal(legacyPostIdOf(order({ meta_data: [] })), null);
});

test("intentIdOf from meta", () => {
  const o = order({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }] });
  assert.equal(intentIdOf(o), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  const o = order({ meta_data: [], transaction_id: "pi_456" });
  assert.equal(intentIdOf(o), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  const o = order({ meta_data: [], transaction_id: "ch_789" });
  assert.equal(intentIdOf(o), null);
});
