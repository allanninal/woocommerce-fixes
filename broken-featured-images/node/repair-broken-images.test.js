import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, paymentConfirmed } from "./repair-broken-images.js";

const product = (over = {}) => ({
  id: 1,
  images: [{ id: 55, src: "https://example.com/wp-content/uploads/photo.jpg" }],
  ...over,
});

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });

test("clear when image not reachable", () => {
  assert.equal(decide(product(), false)[0], "clear");
});

test("skip when image reachable", () => {
  assert.equal(decide(product(), true)[0], "skip");
});

test("skip when no images at all", () => {
  assert.equal(decide(product({ images: [] }), null)[0], "skip");
});

test("skip when no reachability result", () => {
  assert.equal(decide(product(), null)[0], "skip");
});

test("paymentConfirmed true when matching and succeeded", () => {
  assert.equal(paymentConfirmed({ status: "processing", total: "50.00" }, intent()), true);
});

test("paymentConfirmed false when order not paid status", () => {
  assert.equal(paymentConfirmed({ status: "pending", total: "50.00" }, intent()), false);
});

test("paymentConfirmed false when no intent", () => {
  assert.equal(paymentConfirmed({ status: "processing", total: "50.00" }, null), false);
});

test("paymentConfirmed false when intent not succeeded", () => {
  assert.equal(
    paymentConfirmed({ status: "processing", total: "50.00" }, intent({ status: "requires_payment_method" })),
    false
  );
});

test("paymentConfirmed false when amount mismatch", () => {
  assert.equal(paymentConfirmed({ status: "processing", total: "80.00" }, intent()), false);
});

test("intentIdOf from meta", () => {
  assert.equal(
    intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }),
    "pi_123"
  );
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});
