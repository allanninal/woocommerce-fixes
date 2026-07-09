import { test } from "node:test";
import assert from "node:assert/strict";
import { getMeta, needsBackfill } from "./backfill-intent-id.js";

const order = (over = {}) => ({ payment_method: "stripe", status: "pending", meta_data: [], ...over });

test("needs backfill when id missing", () => {
  assert.equal(needsBackfill(order()), true);
});

test("skip when id present", () => {
  assert.equal(needsBackfill(order({ meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }] })), false);
});

test("skip when already paid", () => {
  assert.equal(needsBackfill(order({ status: "processing" })), false);
});

test("skip non stripe", () => {
  assert.equal(needsBackfill(order({ payment_method: "paypal" })), false);
});

test("getMeta reads value", () => {
  assert.equal(getMeta(order({ meta_data: [{ key: "_stripe_charge_id", value: "ch_9" }] }), "_stripe_charge_id"), "ch_9");
});
