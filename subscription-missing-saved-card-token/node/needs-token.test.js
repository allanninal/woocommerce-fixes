import { test } from "node:test";
import assert from "node:assert/strict";
import { needsTokenBackfill } from "./backfill-sub-token.js";

const sub = (over = {}) => ({ payment_method: "stripe", status: "active", meta_data: [], ...over });

test("needs backfill when no customer", () => {
  assert.equal(needsTokenBackfill(sub()), true);
});

test("skip when customer present", () => {
  assert.equal(needsTokenBackfill(sub({ meta_data: [{ key: "_stripe_customer_id", value: "cus_1" }] })), false);
});

test("skip cancelled", () => {
  assert.equal(needsTokenBackfill(sub({ status: "cancelled" })), false);
});

test("skip non stripe", () => {
  assert.equal(needsTokenBackfill(sub({ payment_method: "paypal" })), false);
});
