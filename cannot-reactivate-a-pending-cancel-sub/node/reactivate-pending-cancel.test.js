import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf } from "./reactivate-pending-cancel.js";

const order = (over = {}) => ({
  meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }],
  transaction_id: "",
  ...over,
});

const sub = (over = {}) => ({ status: "pending-cancel", schedule_end: "2026-08-01T00:00:00", ...over });

const method = (over = {}) => ({ status: "succeeded", payment_method: "pm_1", ...over });

test("repair when pending-cancel and card ok", () => {
  assert.equal(decide(sub(), order(), method())[0], "repair");
});

test("repair even with no leftover end date", () => {
  const [action, reason] = decide(sub({ schedule_end: "" }), order(), method());
  assert.equal(action, "repair");
  assert.match(reason, /no leftover end date/);
});

test("skip when subscription missing", () => {
  assert.equal(decide(null, order(), method())[0], "skip");
});

test("skip when status not reactivatable", () => {
  assert.equal(decide(sub({ status: "active" }), order(), method())[0], "skip");
});

test("skip when on-hold is a separate case", () => {
  assert.equal(decide(sub({ status: "on-hold" }), order(), method())[0], "skip");
});

test("blocked when no saved intent", () => {
  const [action, reason] = decide(sub(), order({ meta_data: [], transaction_id: "" }), method());
  assert.equal(action, "blocked");
  assert.match(reason, /no saved PaymentIntent/);
});

test("blocked when payment method missing", () => {
  const [action, reason] = decide(sub(), order(), null);
  assert.equal(action, "blocked");
  assert.match(reason, /could not read/);
});

test("blocked when card not usable", () => {
  const [action, reason] = decide(sub(), order(), method({ status: "requires_payment_method" }));
  assert.equal(action, "blocked");
  assert.match(reason, /not currently usable/);
});

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf(order()), "pi_1");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("intentIdOf null when order is null", () => {
  assert.equal(intentIdOf(null), null);
});
