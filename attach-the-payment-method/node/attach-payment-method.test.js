import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, paymentMethodIdOf } from "./attach-payment-method.js";

const pm = (over = {}) => ({ id: "pm_1", customer: null, ...over });

test("attach when unattached", () => {
  assert.equal(decide("cus_1", pm())[0], "attach");
});

test("ok when already attached to right customer", () => {
  assert.equal(decide("cus_1", pm({ customer: "cus_1" }))[0], "ok");
});

test("conflict when attached to other customer", () => {
  assert.equal(decide("cus_1", pm({ customer: "cus_2" }))[0], "conflict");
});

test("skip when no payment method", () => {
  assert.equal(decide("cus_1", null)[0], "skip");
});

test("skip when no stripe customer id", () => {
  assert.equal(decide(null, pm())[0], "skip");
});

test("paymentMethodIdOf prefers transaction_id pm_", () => {
  assert.equal(paymentMethodIdOf({ transaction_id: "pm_555", meta_data: [] }), "pm_555");
});

test("paymentMethodIdOf falls back to intent meta", () => {
  assert.equal(
    paymentMethodIdOf({ transaction_id: "", meta_data: [{ key: "_stripe_intent_id", value: "pi_999" }] }),
    "pi_999"
  );
});

test("paymentMethodIdOf returns null when nothing saved", () => {
  assert.equal(paymentMethodIdOf({ transaction_id: "", meta_data: [] }), null);
});
