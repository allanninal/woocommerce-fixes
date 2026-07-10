import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  orderDisputeMeta,
  disputeAmountMinor,
  intentIdOfDispute,
  formatNote,
} from "./record-disputes.js";

const dispute = (over = {}) => ({
  id: "dp_1",
  status: "warning_needs_response",
  amount: 5000,
  currency: "usd",
  reason: "fraudulent",
  evidence_details: { due_by: 1800000000 },
  ...over,
});

test("record when never recorded", () => {
  const order = { id: 10, status: "processing", meta_data: [] };
  assert.equal(decide(order, dispute())[0], "record");
});

test("skip when status unchanged", () => {
  const order = {
    id: 10,
    status: "processing",
    meta_data: [{ key: "_dispute_status", value: "warning_needs_response" }],
  };
  assert.equal(decide(order, dispute())[0], "skip");
});

test("record when status moved on", () => {
  const order = {
    id: 10,
    status: "processing",
    meta_data: [{ key: "_dispute_status", value: "warning_needs_response" }],
  };
  assert.equal(decide(order, dispute({ status: "lost" }))[0], "record");
});

test("orphan when order missing", () => {
  const [action, reason] = decide(null, dispute());
  assert.equal(action, "orphan");
  assert.match(reason, /no order/);
});

test("orderDisputeMeta reads existing value", () => {
  const order = { meta_data: [{ key: "_dispute_status", value: "won" }] };
  assert.equal(orderDisputeMeta(order), "won");
});

test("orderDisputeMeta is null when absent", () => {
  const order = { meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }] };
  assert.equal(orderDisputeMeta(order), null);
});

test("disputeAmountMinor is already cents", () => {
  assert.equal(disputeAmountMinor(dispute({ amount: 12345 })), 12345);
});

test("intentIdOfDispute from expanded charge", async () => {
  const d = dispute({ charge: { payment_intent: "pi_abc" } });
  assert.equal(await intentIdOfDispute(d), "pi_abc");
});

test("intentIdOfDispute is null when charge missing", async () => {
  const d = dispute({ charge: null });
  assert.equal(await intentIdOfDispute(d), null);
});

test("formatNote includes status, amount, and reason", () => {
  const note = formatNote(dispute(), "recorded by the disputes reconciler");
  assert.match(note, /warning_needs_response/);
  assert.match(note, /50\.00 USD/);
  assert.match(note, /fraudulent/);
});
