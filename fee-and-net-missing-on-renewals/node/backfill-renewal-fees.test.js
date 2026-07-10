import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isRenewalOrder, hasFeeAndNet, intentIdOf, toMajor } from "./backfill-renewal-fees.js";

const renewalOrder = (over = {}) => ({
  status: "processing",
  meta_data: [
    { key: "_subscription_renewal", value: "9" },
    { key: "_stripe_intent_id", value: "pi_1" },
  ],
  ...over,
});

const balanceTransaction = (over = {}) => ({ fee: 88, net: 4912, ...over });

test("fix when renewal paid and missing fee", () => {
  assert.equal(decide(renewalOrder(), balanceTransaction())[0], "fix");
});

test("skip when not a renewal", () => {
  const order = { status: "processing", meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }] };
  assert.equal(decide(order, balanceTransaction())[0], "skip");
});

test("skip when fee and net already saved", () => {
  const order = renewalOrder({
    meta_data: [
      { key: "_subscription_renewal", value: "9" },
      { key: "_stripe_intent_id", value: "pi_1" },
      { key: "_stripe_fee", value: "0.88" },
      { key: "_stripe_net", value: "49.12" },
    ],
  });
  assert.equal(decide(order, balanceTransaction())[0], "skip");
});

test("skip when renewal not yet paid", () => {
  assert.equal(decide(renewalOrder({ status: "pending" }), balanceTransaction())[0], "skip");
});

test("skip when renewal already refunded status", () => {
  assert.equal(decide(renewalOrder({ status: "refunded" }), balanceTransaction())[0], "skip");
});

test("orphan when no intent id", () => {
  const order = renewalOrder({ meta_data: [{ key: "_subscription_renewal", value: "9" }] });
  assert.equal(decide(order, balanceTransaction())[0], "orphan");
});

test("orphan when no balance transaction", () => {
  assert.equal(decide(renewalOrder(), null)[0], "orphan");
});

test("orphan when balance transaction missing fee", () => {
  const bt = balanceTransaction({ fee: null });
  assert.equal(decide(renewalOrder(), bt)[0], "orphan");
});

test("orphan when balance transaction missing net", () => {
  const bt = balanceTransaction({ net: null });
  assert.equal(decide(renewalOrder(), bt)[0], "orphan");
});

test("isRenewalOrder true with meta", () => {
  assert.equal(isRenewalOrder(renewalOrder()), true);
});

test("isRenewalOrder false without meta", () => {
  assert.equal(isRenewalOrder({ meta_data: [] }), false);
});

test("hasFeeAndNet false when partial", () => {
  const order = { meta_data: [{ key: "_stripe_fee", value: "0.88" }] };
  assert.equal(hasFeeAndNet(order), false);
});

test("hasFeeAndNet true when both present", () => {
  const order = {
    meta_data: [
      { key: "_stripe_fee", value: "0.88" },
      { key: "_stripe_net", value: "49.12" },
    ],
  };
  assert.equal(hasFeeAndNet(order), true);
});

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("toMajor converts cents to dollars", () => {
  assert.equal(toMajor(4912), 49.12);
});

test("toMajor rounds half cent up", () => {
  assert.equal(toMajor(4913), 49.13);
});
