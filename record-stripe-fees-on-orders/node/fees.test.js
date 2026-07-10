import { test } from "node:test";
import assert from "node:assert/strict";
import { intentIdOf, hasFeeRecorded, feeAndNet } from "./record-fees.js";

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_1" }], transaction_id: "" }), "pi_1");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_2" }), "pi_2");
});

test("intentIdOf null when charge id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_3" }), null);
});

test("hasFeeRecorded true", () => {
  assert.equal(hasFeeRecorded({ meta_data: [{ key: "_stripe_fee", value: "1.20" }] }), true);
});

test("hasFeeRecorded false", () => {
  assert.equal(hasFeeRecorded({ meta_data: [{ key: "_other", value: "x" }] }), false);
});

test("feeAndNet converts cents", () => {
  assert.deepEqual(feeAndNet({ fee: 175, net: 4825 }), { fee: 1.75, net: 48.25 });
});

test("feeAndNet null when missing transaction", () => {
  assert.equal(feeAndNet(null), null);
});

test("feeAndNet null when fields absent", () => {
  assert.equal(feeAndNet({ fee: 100 }), null);
});
