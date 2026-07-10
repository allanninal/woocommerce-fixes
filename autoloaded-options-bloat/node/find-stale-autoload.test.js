import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, orderIdFromOption, intentIdOf } from "./find-stale-autoload.js";

const option = (over = {}) => ({ option_name: "_wc_stripe_idempotency_1042", bytes: 20000, ...over });
const intent = (over = {}) => ({ status: "succeeded", ...over });

test("demote when order and intent finished", () => {
  const order = { status: "completed" };
  assert.equal(decide(option(), order, intent())[0], "demote");
});

test("skip when below size threshold", () => {
  const order = { status: "completed" };
  assert.equal(decide(option({ bytes: 500 }), order, intent())[0], "skip");
});

test("skip when option name not ours", () => {
  const order = { status: "completed" };
  const result = decide(option({ option_name: "_transient_unrelated_thing" }), order, intent());
  assert.equal(result[0], "skip");
});

test("orphan when order missing", () => {
  assert.equal(decide(option(), null, null)[0], "orphan");
});

test("keep when order still active", () => {
  const order = { status: "pending" };
  assert.equal(decide(option(), order, intent())[0], "keep");
});

test("keep when intent still active", () => {
  const order = { status: "processing" };
  assert.equal(decide(option(), order, intent({ status: "requires_action" }))[0], "keep");
});

test("demote when intent missing but order finished", () => {
  const order = { status: "refunded" };
  assert.equal(decide(option(), order, null)[0], "demote");
});

test("orderIdFromOption matches digits", () => {
  assert.equal(orderIdFromOption("_wc_stripe_idempotency_1042"), 1042);
  assert.equal(orderIdFromOption("_wc_stripe_intent_77"), 77);
  assert.equal(orderIdFromOption("_wc_stripe_lock_5"), 5);
});

test("orderIdFromOption null for other names", () => {
  assert.equal(orderIdFromOption("_transient_wc_report"), null);
});

test("intentIdOf from meta", () => {
  assert.equal(
    intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }),
    "pi_123",
  );
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});
