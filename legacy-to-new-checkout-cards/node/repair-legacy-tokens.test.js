import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, gatewayIdOf, isLegacyShaped, isPaymentMethodShaped } from "./repair-legacy-tokens.js";

const token = (over = {}) => ({ id: 1, token: "pm_123", is_default: false, ...over });
const paymentMethod = (over = {}) => ({ object: "payment_method", id: "pm_123", customer: "cus_1", ...over });
const source = (over = {}) => ({ object: "source", id: "src_123", status: "chargeable", ...over });

test("keep attached PaymentMethod", () => {
  assert.equal(decide(token({ token: "pm_123" }), paymentMethod())[0], "keep");
});

test("drop PaymentMethod missing on Stripe", () => {
  assert.equal(decide(token({ token: "pm_123" }), null)[0], "drop");
});

test("drop PaymentMethod not attached to a customer", () => {
  assert.equal(decide(token({ token: "pm_123" }), paymentMethod({ customer: null }))[0], "drop");
});

test("drop legacy Source token", () => {
  assert.equal(decide(token({ token: "src_abc" }), source())[0], "drop");
});

test("drop legacy card token", () => {
  assert.equal(decide(token({ token: "card_abc" }), null)[0], "drop");
});

test("drop legacy Source no longer chargeable", () => {
  assert.equal(decide(token({ token: "src_abc" }), source({ status: "consumed" }))[0], "drop");
});

test("skip when no gateway id", () => {
  assert.equal(decide(token({ token: "" }), null)[0], "skip");
});

test("skip unrecognized token shape", () => {
  assert.equal(decide(token({ token: "tok_weird" }), null)[0], "skip");
});

test("gatewayIdOf trims and reads token field", () => {
  assert.equal(gatewayIdOf({ token: "  pm_9  " }), "pm_9");
  assert.equal(gatewayIdOf({ token: "" }), null);
  assert.equal(gatewayIdOf({}), null);
});

test("isLegacyShaped / isPaymentMethodShaped", () => {
  assert.equal(isLegacyShaped("src_1"), true);
  assert.equal(isLegacyShaped("card_1"), true);
  assert.equal(isLegacyShaped("pm_1"), false);
  assert.equal(isPaymentMethodShaped("pm_1"), true);
  assert.equal(isPaymentMethodShaped("src_1"), false);
});
