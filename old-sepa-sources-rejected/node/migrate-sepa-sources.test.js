import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, isLegacySource, tokenOf } from "./migrate-sepa-sources.js";

const order = (over = {}) => ({ id: 501, status: "pending", ...over });

test("migrate when legacy Source and replacement exists", () => {
  assert.equal(decide(order(), "src_1AbCdEfGhIjKlMnO", "pm_1XyZ")[0], "migrate");
});

test("flag when legacy Source and no replacement", () => {
  assert.equal(decide(order(), "src_1AbCdEfGhIjKlMnO", null)[0], "flag");
});

test("skip when token is not a legacy Source", () => {
  assert.equal(decide(order(), "pm_1XyZ", null)[0], "skip");
});

test("skip when token missing", () => {
  assert.equal(decide(order(), null, null)[0], "skip");
});

test("skip when order not in a renewal status", () => {
  assert.equal(decide(order({ status: "completed" }), "src_1AbCdEfGhIjKlMnO", "pm_1XyZ")[0], "skip");
});

test("isLegacySource true for src_ prefix", () => {
  assert.equal(isLegacySource("src_1AbCdEfGhIjKlMnO"), true);
});

test("isLegacySource false for PaymentMethod", () => {
  assert.equal(isLegacySource("pm_1XyZ"), false);
});

test("isLegacySource false for null", () => {
  assert.equal(isLegacySource(null), false);
});

test("tokenOf from meta", () => {
  const o = { meta_data: [{ key: "_stripe_intent_id", value: "src_123" }], transaction_id: "" };
  assert.equal(tokenOf(o), "src_123");
});

test("tokenOf falls back to transaction_id", () => {
  const o = { meta_data: [], transaction_id: "src_456" };
  assert.equal(tokenOf(o), "src_456");
});

test("tokenOf null when nothing saved", () => {
  const o = { meta_data: [], transaction_id: "" };
  assert.equal(tokenOf(o), null);
});
