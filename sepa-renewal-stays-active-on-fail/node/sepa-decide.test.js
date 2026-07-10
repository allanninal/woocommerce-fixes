import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./repair-sepa-renewal.js";

const intent = (over = {}) => ({ status: "requires_payment_method", id: "pi_1", ...over });

test("repair when mandate failed on paid order", () => {
  assert.equal(decide({ status: "processing" }, intent())[0], "repair");
});

test("repair when mandate canceled", () => {
  assert.equal(decide({ status: "completed" }, intent({ status: "canceled" }))[0], "repair");
});

test("wait when still processing", () => {
  assert.equal(decide({ status: "processing" }, intent({ status: "processing" }))[0], "wait");
});

test("skip when succeeded", () => {
  assert.equal(decide({ status: "processing" }, intent({ status: "succeeded" }))[0], "skip");
});

test("skip when already on hold", () => {
  assert.equal(decide({ status: "on-hold" }, intent())[0], "skip");
});

test("skip when already failed", () => {
  assert.equal(decide({ status: "failed" }, intent())[0], "skip");
});

test("skip when order not paid", () => {
  assert.equal(decide({ status: "pending" }, intent())[0], "skip");
});

test("skip when no intent", () => {
  assert.equal(decide({ status: "processing" }, null)[0], "skip");
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
