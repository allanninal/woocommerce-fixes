import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, chargeIdOf, intentIdOf, orderAmountMinor } from "./resolve-charge-id.js";

const intent = (over = {}) => ({
  status: "succeeded",
  amount_received: 5000,
  latest_charge: "ch_new_1",
  ...over,
});

const order = (over = {}) => ({
  status: "pending",
  total: "50.00",
  transaction_id: "",
  meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }],
  ...over,
});

test("chargeIdOf prefers latest_charge string", () => {
  assert.equal(
    chargeIdOf({ latest_charge: "ch_new_1", charges: { data: [{ id: "ch_old_1" }] } }),
    "ch_new_1"
  );
});

test("chargeIdOf falls back to legacy charges list", () => {
  assert.equal(
    chargeIdOf({ latest_charge: null, charges: { data: [{ id: "ch_old_1" }] } }),
    "ch_old_1"
  );
});

test("chargeIdOf handles expanded latest_charge object", () => {
  assert.equal(chargeIdOf({ latest_charge: { id: "ch_expanded_1" } }), "ch_expanded_1");
});

test("chargeIdOf null when neither shape present", () => {
  assert.equal(chargeIdOf({ latest_charge: null, charges: { data: [] } }), null);
});

test("repair when new shape only and no transaction id", () => {
  assert.equal(decide(order(), intent())[0], "repair");
});

test("repair when only legacy charges shape present", () => {
  const oldShapeIntent = intent({ latest_charge: null, charges: { data: [{ id: "ch_old_1" }] } });
  assert.equal(decide(order(), oldShapeIntent)[0], "repair");
});

test("skip when no saved intent id", () => {
  assert.equal(decide(order({ meta_data: [], transaction_id: "" }), intent())[0], "skip");
});

test("skip when order already has a transaction id", () => {
  assert.equal(decide(order({ transaction_id: "ch_already_set" }), intent())[0], "skip");
});

test("skip when intent not succeeded", () => {
  assert.equal(decide(order(), intent({ status: "requires_payment_method" }))[0], "skip");
});

test("orphan when succeeded but no charge id on either shape", () => {
  assert.equal(decide(order(), intent({ latest_charge: null, charges: { data: [] } }))[0], "orphan");
});

test("mismatch when amount differs", () => {
  assert.equal(decide(order({ total: "80.00" }), intent())[0], "mismatch");
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

test("intentIdOf null when transaction is already a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("orderAmountMinor converts to cents", () => {
  assert.equal(orderAmountMinor({ total: "19.99" }), 1999);
});
