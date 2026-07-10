import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, orderCurrency } from "./detect-currency-not-enabled.js";

const ENABLED = new Set(["usd", "eur", "gbp"]);

test("flag when currency not enabled", () => {
  const [action, reason] = decide({ status: "pending", currency: "SEK" }, ENABLED, null);
  assert.equal(action, "flag");
  assert.match(reason, /sek/);
});

test("skip when currency enabled and no intent", () => {
  assert.equal(decide({ status: "pending", currency: "USD" }, ENABLED, null)[0], "skip");
});

test("flag when Stripe reports currency_not_enabled error", () => {
  const intent = { last_payment_error: { code: "currency_not_enabled" } };
  const [action, reason] = decide({ status: "failed", currency: "EUR" }, ENABLED, intent);
  assert.equal(action, "flag");
  assert.match(reason, /currency_not_enabled/);
});

test("skip when order not in checkable status", () => {
  assert.equal(decide({ status: "processing", currency: "SEK" }, ENABLED, null)[0], "skip");
});

test("skip when order has no currency", () => {
  assert.equal(decide({ status: "pending", currency: "" }, ENABLED, null)[0], "skip");
});

test("skip when currency enabled and unrelated error", () => {
  const intent = { last_payment_error: { code: "card_declined" } };
  assert.equal(decide({ status: "failed", currency: "USD" }, ENABLED, intent)[0], "skip");
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

test("orderCurrency lower cases", () => {
  assert.equal(orderCurrency({ currency: "USD" }), "usd");
});
