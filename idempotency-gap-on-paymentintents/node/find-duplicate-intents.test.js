import { test } from "node:test";
import assert from "node:assert/strict";
import { findCandidateDuplicates, intentIdOf, orderAmountMinor } from "./find-duplicate-intents.js";

const intent = (over = {}) => ({ id: "pi_primary", status: "succeeded", amount_received: 5000, created: 1_700_000_000, ...over });

test("finds duplicate with same amount in same window", () => {
  const primary = intent();
  const other = intent({ id: "pi_retry", created: 1_700_000_120 });
  const result = findCandidateDuplicates(primary, [other], 5000, 1800);
  assert.equal(result.length, 1);
  assert.equal(result[0][0].id, "pi_retry");
});

test("ignores itself", () => {
  const primary = intent();
  const result = findCandidateDuplicates(primary, [intent()], 5000, 1800);
  assert.deepEqual(result, []);
});

test("ignores non succeeded candidates", () => {
  const primary = intent();
  const other = intent({ id: "pi_failed", status: "requires_payment_method", created: 1_700_000_060 });
  const result = findCandidateDuplicates(primary, [other], 5000, 1800);
  assert.deepEqual(result, []);
});

test("ignores different amount", () => {
  const primary = intent();
  const other = intent({ id: "pi_other_amount", amount_received: 1500, created: 1_700_000_060 });
  const result = findCandidateDuplicates(primary, [other], 5000, 1800);
  assert.deepEqual(result, []);
});

test("ignores outside time window", () => {
  const primary = intent();
  const other = intent({ id: "pi_far_away", created: 1_700_000_000 + 7200 });
  const result = findCandidateDuplicates(primary, [other], 5000, 1800);
  assert.deepEqual(result, []);
});

test("no duplicates when primary not succeeded", () => {
  const primary = intent({ status: "requires_payment_method" });
  const other = intent({ id: "pi_retry", created: 1_700_000_120 });
  const result = findCandidateDuplicates(primary, [other], 5000, 1800);
  assert.deepEqual(result, []);
});

test("no duplicates when primary missing", () => {
  const result = findCandidateDuplicates(null, [intent()], 5000, 1800);
  assert.deepEqual(result, []);
});

test("multiple duplicates are all returned", () => {
  const primary = intent();
  const others = [intent({ id: "pi_retry_1", created: 1_700_000_060 }), intent({ id: "pi_retry_2", created: 1_700_000_090 })];
  const result = findCandidateDuplicates(primary, others, 5000, 1800);
  const ids = result.map(([d]) => d.id).sort();
  assert.deepEqual(ids, ["pi_retry_1", "pi_retry_2"]);
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

test("orderAmountMinor converts to cents", () => {
  assert.equal(orderAmountMinor({ total: "50.00" }), 5000);
});
