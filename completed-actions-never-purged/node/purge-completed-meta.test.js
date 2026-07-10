import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, purgeableMetaIds } from "./purge-completed-meta.js";

const NOW = new Date("2026-07-10T00:00:00Z");

const order = (over = {}) => ({
  status: "completed",
  total: "50.00",
  date_modified_gmt: "2026-01-01T00:00:00",
  meta_data: [{ id: 1, key: "_reconciler_checked_at", value: "2026-01-01" }],
  ...over,
});

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });

test("purge when settled, stale, and confirmed", () => {
  assert.equal(decide(order(), intent(), 90, NOW)[0], "purge");
});

test("skip when order not settled", () => {
  assert.equal(decide(order({ status: "pending" }), intent(), 90, NOW)[0], "skip");
});

test("skip when nothing to purge", () => {
  assert.equal(decide(order({ meta_data: [] }), intent(), 90, NOW)[0], "skip");
});

test("skip when inside retention window", () => {
  const recent = order({ date_modified_gmt: "2026-07-01T00:00:00" });
  assert.equal(decide(recent, intent(), 90, NOW)[0], "skip");
});

test("keep when Stripe no longer confirms", () => {
  assert.equal(decide(order(), null, 90, NOW)[0], "keep");
});

test("keep when intent status not succeeded", () => {
  assert.equal(decide(order(), intent({ status: "canceled" }), 90, NOW)[0], "keep");
});

test("keep when amount no longer matches", () => {
  assert.equal(decide(order({ total: "80.00" }), intent(), 90, NOW)[0], "keep");
});

test("intentIdOf from meta", () => {
  const o = order({ meta_data: [{ id: 2, key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" });
  assert.equal(intentIdOf(o), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  const o = order({ meta_data: [], transaction_id: "pi_456" });
  assert.equal(intentIdOf(o), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  const o = order({ meta_data: [], transaction_id: "ch_789" });
  assert.equal(intentIdOf(o), null);
});

test("purgeableMetaIds keeps only known keys", () => {
  const o = order({
    meta_data: [
      { id: 1, key: "_reconciler_checked_at", value: "x" },
      { id: 2, key: "_billing_address_index", value: "keep me" },
    ],
  });
  assert.deepEqual(purgeableMetaIds(o), [1]);
});

test("purgeableMetaIds empty when none match", () => {
  const o = order({ meta_data: [{ id: 3, key: "_billing_address_index", value: "keep me" }] });
  assert.deepEqual(purgeableMetaIds(o), []);
});
