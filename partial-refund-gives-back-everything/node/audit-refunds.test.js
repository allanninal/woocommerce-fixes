import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  intentIdOf,
  wooIntendedRefundMinor,
  stripeRefundedMinor,
} from "./audit-refunds.js";

const charge = (over = {}) => ({ amount_refunded: 1000, ...over });

test("overrefund when Stripe returned more than intended", () => {
  const [action, , gap] = decide({ id: 1, status: "processing" }, charge({ amount_refunded: 5000 }), 1000, 5000);
  assert.equal(action, "overrefund");
  assert.equal(gap, 4000);
});

test("ok when amounts match", () => {
  const [action, , gap] = decide({ id: 2, status: "processing" }, charge({ amount_refunded: 1000 }), 1000, 1000);
  assert.equal(action, "ok");
  assert.equal(gap, 0);
});

test("ok within rounding tolerance", () => {
  const [action] = decide({ id: 3, status: "processing" }, charge({ amount_refunded: 1001 }), 1000, 1001);
  assert.equal(action, "ok");
});

test("underrefund when Stripe returned less", () => {
  const [action] = decide({ id: 4, status: "processing" }, charge({ amount_refunded: 500 }), 1000, 500);
  assert.equal(action, "underrefund");
});

test("orphan when no charge found", () => {
  const [action, , gap] = decide({ id: 5, status: "processing" }, null, 1000, 0);
  assert.equal(action, "orphan");
  assert.equal(gap, 0);
});

test("skip when no refund recorded", () => {
  const [action] = decide({ id: 6, status: "processing" }, charge({ amount_refunded: 0 }), 0, 0);
  assert.equal(action, "skip");
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

test("intentIdOf accepts charge id fallback", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), "ch_789");
});

test("intentIdOf null when transaction is unrelated", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "txn_other" }), null);
});

test("wooIntendedRefundMinor converts dollars to cents", () => {
  assert.equal(wooIntendedRefundMinor({ total_refunded: "12.50" }), 1250);
});

test("wooIntendedRefundMinor handles missing value", () => {
  assert.equal(wooIntendedRefundMinor({}), 0);
});

test("stripeRefundedMinor reads amount_refunded", () => {
  assert.equal(stripeRefundedMinor(charge({ amount_refunded: 750 })), 750);
});

test("stripeRefundedMinor handles null charge", () => {
  assert.equal(stripeRefundedMinor(null), 0);
});
