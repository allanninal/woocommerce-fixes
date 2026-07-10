import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, cancelableIntent } from "./purge-checkout-drafts.js";

const NOW = Date.now() / 1000;
const DAY = 24 * 3600;

const draft = (hoursOld = 48, over = {}) => ({
  status: "checkout-draft",
  date_modified_gmt: new Date((NOW - hoursOld * 3600) * 1000).toISOString().replace("Z", ""),
  ...over,
});

const intent = (over = {}) => ({ id: "pi_1", status: "requires_payment_method", ...over });

test("purge when stale and no payment", () => {
  assert.equal(decide(draft(48), null, NOW)[0], "purge");
});

test("skip when still fresh", () => {
  assert.equal(decide(draft(1), null, NOW)[0], "skip");
});

test("skip when not a draft", () => {
  assert.equal(decide(draft(48, { status: "pending" }), null, NOW)[0], "skip");
});

test("keep when intent succeeded", () => {
  assert.equal(decide(draft(48), intent({ status: "succeeded" }), NOW)[0], "keep");
});

test("keep when intent processing", () => {
  assert.equal(decide(draft(48), intent({ status: "processing" }), NOW)[0], "keep");
});

test("purge when intent still requires payment method", () => {
  assert.equal(decide(draft(48), intent({ status: "requires_payment_method" }), NOW)[0], "purge");
});

test("custom stale after hours", () => {
  assert.equal(decide(draft(10), null, NOW, 5)[0], "purge");
  assert.equal(decide(draft(10), null, NOW, 20)[0], "skip");
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

test("cancelableIntent true when open", () => {
  assert.equal(cancelableIntent(intent({ status: "requires_action" })), true);
});

test("cancelableIntent false when succeeded", () => {
  assert.equal(cancelableIntent(intent({ status: "succeeded" })), false);
});

test("cancelableIntent false when none", () => {
  assert.equal(cancelableIntent(null), false);
});
