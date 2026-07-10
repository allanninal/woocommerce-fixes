import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, savedPaymentRef } from "./clear-stale-card.js";

const pm = (over = {}) => ({ customer: "cus_1", ...over });

test("ok when still attached", () => {
  assert.equal(decide("cus_1", "pm_1", pm())[0], "ok");
});

test("clear when payment method missing", () => {
  assert.equal(decide("cus_1", "pm_1", null)[0], "clear");
});

test("clear when attached to a different customer", () => {
  assert.equal(decide("cus_1", "pm_1", pm({ customer: "cus_2" }))[0], "clear");
});

test("skip when nothing saved", () => {
  assert.equal(decide(null, null, null)[0], "skip");
});

test("skip when customer missing but pm present", () => {
  assert.equal(decide(null, "pm_1", pm())[0], "skip");
});

test("skip when pm missing but customer present", () => {
  assert.equal(decide("cus_1", null, null)[0], "skip");
});

test("savedPaymentRef reads _stripe_source_id and customer id", () => {
  const sub = {
    meta_data: [
      { key: "_stripe_customer_id", value: "cus_9" },
      { key: "_stripe_source_id", value: "pm_9" },
    ],
  };
  assert.deepEqual(savedPaymentRef(sub), { customerId: "cus_9", pmId: "pm_9" });
});

test("savedPaymentRef falls back to _payment_method_token", () => {
  const sub = {
    meta_data: [
      { key: "_stripe_customer_id", value: "cus_9" },
      { key: "_payment_method_token", value: "pm_legacy" },
    ],
  };
  assert.deepEqual(savedPaymentRef(sub), { customerId: "cus_9", pmId: "pm_legacy" });
});

test("savedPaymentRef returns nulls when nothing saved", () => {
  assert.deepEqual(savedPaymentRef({ meta_data: [] }), { customerId: null, pmId: null });
});
