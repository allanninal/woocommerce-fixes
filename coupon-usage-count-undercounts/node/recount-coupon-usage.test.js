import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, orderCountsAsUsed, intentIdOf } from "./recount-coupon-usage.js";

const intent = (over = {}) => ({ status: "succeeded", ...over });

test("ok when stored matches real", () => {
  assert.equal(decide({ usage_count: 3 }, 3)[0], "ok");
});

test("correct when stored undercounts", () => {
  const [action, reason] = decide({ usage_count: 2 }, 5);
  assert.equal(action, "correct");
  assert.match(reason, /undercounted/);
});

test("correct when stored overcounts", () => {
  const [action, reason] = decide({ usage_count: 7 }, 4);
  assert.equal(action, "correct");
  assert.match(reason, /overcounted/);
});

test("order counts when processing and succeeded", () => {
  assert.equal(orderCountsAsUsed({ status: "processing" }, intent()), true);
});

test("order does not count when cancelled", () => {
  assert.equal(orderCountsAsUsed({ status: "cancelled" }, intent()), false);
});

test("order does not count when no intent", () => {
  assert.equal(orderCountsAsUsed({ status: "completed" }, null), false);
});

test("order does not count when intent not succeeded", () => {
  assert.equal(
    orderCountsAsUsed({ status: "completed" }, intent({ status: "requires_payment_method" })),
    false
  );
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
