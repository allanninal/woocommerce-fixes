import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, daysUntil, intentIdOf } from "./check-one-off-methods.js";

const intent = (over = {}) => ({ payment_method_types: ["ideal"], customer: "cus_1", ...over });

test("flag when iDEAL and no reusable card and renewal close", () => {
  assert.equal(decide({ renewal_window_days: 7 }, intent(), false, 3)[0], "flag");
});

test("flag when Bancontact and no reusable card and renewal close", () => {
  assert.equal(decide({ renewal_window_days: 7 }, intent({ payment_method_types: ["bancontact"] }), false, 0)[0], "flag");
});

test("ok when reusable card already on file", () => {
  assert.equal(decide({ renewal_window_days: 7 }, intent(), true, 3)[0], "ok");
});

test("skip when first payment was a card", () => {
  assert.equal(decide({ renewal_window_days: 7 }, intent({ payment_method_types: ["card"] }), false, 3)[0], "skip");
});

test("skip when renewal too far away", () => {
  assert.equal(decide({ renewal_window_days: 7 }, intent(), false, 20)[0], "skip");
});

test("skip when no intent found", () => {
  assert.equal(decide({ renewal_window_days: 7 }, null, false, 3)[0], "skip");
});

test("flag uses default window when subscription is missing it", () => {
  assert.equal(decide({}, intent(), false, 3)[0], "flag");
});

test("flag when method types include ideal alongside other types", () => {
  assert.equal(decide({ renewal_window_days: 7 }, intent({ payment_method_types: ["ideal", "card"] }), false, 3)[0], "flag");
});

test("intentIdOf reads from meta_data", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});

test("daysUntil returns 0 for a date in the past", () => {
  const past = new Date(Date.now() - 5 * 86400000).toISOString().replace("Z", "");
  assert.equal(daysUntil(past), 0);
});

test("daysUntil returns a positive count for a future date", () => {
  const future = new Date(Date.now() + 3 * 86400000 + 3600000).toISOString().replace("Z", "");
  assert.equal(daysUntil(future), 3);
});
