import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, stripeSubIdOf } from "./bulk-pause.js";

const stripeSub = (over = {}) => ({ status: "active", pause_collection: null, ...over });

test("pause when both active", () => {
  assert.equal(decide({ status: "active" }, stripeSub())[0], "pause");
});

test("skip when woo already on hold", () => {
  assert.equal(decide({ status: "on-hold" }, stripeSub())[0], "skip");
});

test("skip when woo cancelled", () => {
  assert.equal(decide({ status: "cancelled" }, stripeSub())[0], "skip");
});

test("skip when stripe already paused", () => {
  assert.equal(decide({ status: "active" }, stripeSub({ pause_collection: { behavior: "void" } }))[0], "skip");
});

test("skip when stripe canceled", () => {
  assert.equal(decide({ status: "active" }, stripeSub({ status: "canceled" }))[0], "skip");
});

test("orphan when no stripe subscription", () => {
  assert.equal(decide({ status: "active" }, null)[0], "orphan");
});

test("stripeSubIdOf from meta", () => {
  assert.equal(
    stripeSubIdOf({ meta_data: [{ key: "_stripe_subscription_id", value: "sub_123" }], transaction_id: "" }),
    "sub_123"
  );
});

test("stripeSubIdOf falls back to transaction_id", () => {
  assert.equal(stripeSubIdOf({ meta_data: [], transaction_id: "sub_456" }), "sub_456");
});

test("stripeSubIdOf null when transaction is not a subscription", () => {
  assert.equal(stripeSubIdOf({ meta_data: [], transaction_id: "pi_789" }), null);
});
