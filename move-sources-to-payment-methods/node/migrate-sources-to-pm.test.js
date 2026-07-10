import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isLegacySource, isAlreadyPaymentMethod, tokenOf } from "./migrate-sources-to-pm.js";

const order = (over = {}) => ({ id: 701, status: "pending", ...over });
const source = (over = {}) => ({ type: "card", status: "chargeable", ...over });

test("migrate when legacy card source is chargeable", () => {
  assert.equal(decide(order(), "src_1AbCdEfGhIjKlMnO", source())[0], "migrate");
});

test("migrate when legacy card source is consumed", () => {
  assert.equal(decide(order(), "src_1AbCdEfGhIjKlMnO", source({ status: "consumed" }))[0], "migrate");
});

test("flag when source missing from stripe", () => {
  assert.equal(decide(order(), "src_1AbCdEfGhIjKlMnO", null)[0], "flag");
});

test("flag when source not a card", () => {
  assert.equal(decide(order(), "src_1AbCdEfGhIjKlMnO", source({ type: "sepa_debit" }))[0], "flag");
});

test("flag when source no longer chargeable", () => {
  assert.equal(decide(order(), "src_1AbCdEfGhIjKlMnO", source({ status: "failed" }))[0], "flag");
});

test("skip when already a payment method", () => {
  assert.equal(decide(order(), "pm_1XyZ", null)[0], "skip");
});

test("skip when no token saved", () => {
  assert.equal(decide(order(), null, null)[0], "skip");
});

test("skip when order status not tracked", () => {
  assert.equal(decide(order({ status: "cancelled" }), "src_1AbCdEfGhIjKlMnO", source())[0], "skip");
});

test("isLegacySource true for src prefix", () => {
  assert.equal(isLegacySource("src_1AbCdEfGhIjKlMnO"), true);
});

test("isLegacySource false for payment method", () => {
  assert.equal(isLegacySource("pm_1XyZ"), false);
});

test("isLegacySource false for null", () => {
  assert.equal(isLegacySource(null), false);
});

test("isAlreadyPaymentMethod true for pm prefix", () => {
  assert.equal(isAlreadyPaymentMethod("pm_1XyZ"), true);
});

test("isAlreadyPaymentMethod false for source", () => {
  assert.equal(isAlreadyPaymentMethod("src_1AbCdEfGhIjKlMnO"), false);
});

test("tokenOf from meta", () => {
  assert.equal(
    tokenOf({ meta_data: [{ key: "_stripe_intent_id", value: "src_123" }], transaction_id: "" }),
    "src_123"
  );
});

test("tokenOf falls back to transaction_id", () => {
  assert.equal(tokenOf({ meta_data: [], transaction_id: "src_456" }), "src_456");
});

test("tokenOf none when nothing saved", () => {
  assert.equal(tokenOf({ meta_data: [], transaction_id: "" }), null);
});
