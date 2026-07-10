import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./release-stale-reservations.js";

const intent = (over = {}) => ({ status: "succeeded", ...over });

test("release when stale and unpaid", () => {
  assert.equal(decide({ status: "pending" }, null, 90, 60)[0], "release");
});

test("release when stale and intent never succeeded", () => {
  assert.equal(decide({ status: "pending" }, intent({ status: "requires_payment_method" }), 90, 60)[0], "release");
});

test("skip when still within hold window", () => {
  assert.equal(decide({ status: "pending" }, null, 10, 60)[0], "skip");
});

test("skip when order not in a holding status", () => {
  assert.equal(decide({ status: "processing" }, null, 200, 60)[0], "skip");
});

test("paid when Stripe shows succeeded", () => {
  assert.equal(decide({ status: "pending" }, intent(), 90, 60)[0], "paid");
});

test("checkout-draft is also a holding status", () => {
  assert.equal(decide({ status: "checkout-draft" }, null, 90, 60)[0], "release");
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
