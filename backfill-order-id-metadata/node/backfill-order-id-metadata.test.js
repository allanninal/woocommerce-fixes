import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./backfill-order-id-metadata.js";

const intent = (over = {}) => ({ id: "pi_1", status: "succeeded", metadata: {}, ...over });

test("backfill when metadata missing", () => {
  assert.equal(decide({ id: 501, status: "processing" }, intent())[0], "backfill");
});

test("skip when metadata already correct", () => {
  assert.equal(decide({ id: 501, status: "processing" }, intent({ metadata: { order_id: "501" } }))[0], "skip");
});

test("backfill when metadata points at wrong order", () => {
  assert.equal(decide({ id: 501, status: "processing" }, intent({ metadata: { order_id: "999" } }))[0], "backfill");
});

test("orphan when intent missing", () => {
  assert.equal(decide({ id: 501, status: "processing" }, null)[0], "orphan");
});

test("skip when intent not paid", () => {
  assert.equal(decide({ id: 501, status: "processing" }, intent({ status: "requires_payment_method" }))[0], "skip");
});

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("backfill when metadata is missing entirely", () => {
  assert.equal(decide({ id: 501, status: "completed" }, intent({ metadata: undefined }))[0], "backfill");
});
