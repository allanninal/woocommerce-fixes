import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, orderAmountMinor } from "./clear-trial-end-false-positive.js";

const sub = (over = {}) => ({ status: "active", trial_total_minor: 0, ...over });
const order = (over = {}) => ({ status: "processing", total: "50.00", ...over });
const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });

test("clear when active, no renewal needed, and no charge due", () => {
  assert.equal(decide(sub({ status: "active", trial_total_minor: 0 }), null, null)[0], "clear");
});

test("unclear when active with no renewal but trial had a charge", () => {
  assert.equal(decide(sub({ status: "active", trial_total_minor: 500 }), null, null)[0], "unclear");
});

test("leave when still on trial", () => {
  assert.equal(decide(sub({ status: "trial" }), null, null)[0], "leave");
});

test("leave when renewal order failed", () => {
  assert.equal(decide(sub(), order({ status: "failed" }), null)[0], "leave");
});

test("unclear when no intent yet", () => {
  assert.equal(decide(sub(), order(), null)[0], "unclear");
});

test("leave when intent not succeeded", () => {
  assert.equal(decide(sub(), order(), intent({ status: "requires_payment_method" }))[0], "leave");
});

test("unclear when amount mismatch", () => {
  assert.equal(decide(sub(), order({ total: "80.00" }), intent())[0], "unclear");
});

test("clear when everything checks out", () => {
  assert.equal(decide(sub(), order(), intent())[0], "clear");
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

test("orderAmountMinor converts to cents", () => {
  assert.equal(orderAmountMinor({ total: "19.99" }), 1999);
});
