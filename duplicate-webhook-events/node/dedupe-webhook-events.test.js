import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, nextLedger, ledgerOf, intentIdOf } from "./dedupe-webhook-events.js";

const event = (over = {}) => ({
  id: "evt_1",
  type: "payment_intent.succeeded",
  data: { object: { metadata: { order_id: "42" } } },
  ...over,
});

test("apply when event is new", () => {
  const order = { id: 42, status: "processing" };
  assert.equal(decide(order, event(), [])[0], "apply");
});

test("skip when event id already in ledger", () => {
  const order = { id: 42, status: "processing" };
  assert.equal(decide(order, event(), ["evt_1"])[0], "skip");
});

test("apply when ledger has other ids", () => {
  const order = { id: 42, status: "processing" };
  assert.equal(decide(order, event(), ["evt_0", "evt_9"])[0], "apply");
});

test("ignore when event type not handled", () => {
  const order = { id: 42, status: "processing" };
  assert.equal(decide(order, event({ type: "charge.refunded" }), [])[0], "ignore");
});

test("orphan when order missing", () => {
  assert.equal(decide(null, event(), [])[0], "orphan");
});

test("nextLedger appends event id", () => {
  assert.deepEqual(nextLedger(["evt_1"], "evt_2"), ["evt_1", "evt_2"]);
});

test("nextLedger caps size", () => {
  const ledger = Array.from({ length: 50 }, (_, i) => `evt_${i}`);
  const result = nextLedger(ledger, "evt_50");
  assert.equal(result.length, 50);
  assert.equal(result[0], "evt_1");
  assert.equal(result[result.length - 1], "evt_50");
});

test("ledgerOf reads meta_data", () => {
  const order = { meta_data: [{ key: "_processed_webhook_event_ids", value: ["evt_1", "evt_2"] }] };
  assert.deepEqual(ledgerOf(order), ["evt_1", "evt_2"]);
});

test("ledgerOf empty when no meta", () => {
  assert.deepEqual(ledgerOf({ meta_data: [] }), []);
});

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});
