import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, stripeSubIdOf } from "./cancel-stripe-subscription.js";

const wooSub = (over = {}) => ({ id: 501, status: "cancelled", meta_data: [], ...over });
const stripeSub = (over = {}) => ({ id: "sub_1", status: "active", ...over });

test("cancel when woo cancelled and stripe still active", () => {
  assert.equal(decide(wooSub(), stripeSub())[0], "cancel");
});

test("cancel when stripe past_due", () => {
  assert.equal(decide(wooSub({ status: "pending-cancel" }), stripeSub({ status: "past_due" }))[0], "cancel");
});

test("ok when stripe already canceled", () => {
  assert.equal(decide(wooSub(), stripeSub({ status: "canceled" }))[0], "ok");
});

test("skip when woo subscription not cancelled", () => {
  assert.equal(decide(wooSub({ status: "active" }), stripeSub())[0], "skip");
});

test("orphan when no stripe subscription", () => {
  assert.equal(decide(wooSub(), null)[0], "orphan");
});

test("stripeSubIdOf from meta", () => {
  assert.equal(
    stripeSubIdOf({ meta_data: [{ key: "_stripe_subscription_id", value: "sub_123" }] }),
    "sub_123"
  );
});

test("stripeSubIdOf falls back to intent meta prefix", () => {
  assert.equal(
    stripeSubIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "sub_456" }] }),
    "sub_456"
  );
});

test("stripeSubIdOf falls back to transaction_id", () => {
  assert.equal(stripeSubIdOf({ meta_data: [], transaction_id: "sub_789" }), "sub_789");
});

test("stripeSubIdOf null when nothing matches", () => {
  assert.equal(
    stripeSubIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "ch_1" }),
    null
  );
});
