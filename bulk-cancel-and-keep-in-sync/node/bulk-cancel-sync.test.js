import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, stripeSubIdOf } from "./bulk-cancel-sync.js";

const wooSub = (status = "active", over = {}) => ({ id: 1, status, ...over });
const stripeSub = (status = "active") => ({ id: "sub_1", status });

test("cancel both when active on both sides", () => {
  assert.equal(decide(wooSub("active"), stripeSub("active"))[0], "cancel_both");
});

test("skip when already cancelled on both sides", () => {
  assert.equal(decide(wooSub("cancelled"), stripeSub("canceled"))[0], "skip");
});

test("cancel stripe only when woo already cancelled", () => {
  assert.equal(decide(wooSub("cancelled"), stripeSub("active"))[0], "cancel_stripe_only");
});

test("cancel woo only when stripe already cancelled", () => {
  assert.equal(decide(wooSub("active"), stripeSub("canceled"))[0], "cancel_woo_only");
});

test("orphan when stripe subscription missing and woo active", () => {
  const [action, reason] = decide(wooSub("active"), null);
  assert.equal(action, "orphan");
  assert.match(reason, /cancel Stripe by hand/);
});

test("orphan when stripe subscription missing and woo already cancelled", () => {
  const [action, reason] = decide(wooSub("cancelled"), null);
  assert.equal(action, "orphan");
  assert.match(reason, /cannot confirm Stripe side/);
});

test("orphan when woo subscription missing", () => {
  assert.equal(decide(null, stripeSub("active"))[0], "orphan");
});

test("incomplete_expired counts as cancelled on stripe", () => {
  assert.equal(decide(wooSub("active"), stripeSub("incomplete_expired"))[0], "cancel_woo_only");
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
