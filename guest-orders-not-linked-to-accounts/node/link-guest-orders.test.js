import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, orderAmountMinor } from "./link-guest-orders.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, ...over });
const customer = (id = 42) => [{ id, email: "shopper@example.com" }];

test("link when one account matches and paid", () => {
  const order = { customer_id: 0, status: "processing", total: "50.00", billing: { email: "shopper@example.com" } };
  assert.equal(decide(order, customer(), intent())[0], "link");
});

test("skip when already linked", () => {
  const order = { customer_id: 42, status: "processing", total: "50.00", billing: { email: "shopper@example.com" } };
  assert.equal(decide(order, customer(), intent())[0], "skip");
});

test("skip when no billing email", () => {
  const order = { customer_id: 0, status: "processing", total: "50.00", billing: {} };
  assert.equal(decide(order, [], null)[0], "skip");
});

test("skip when not paid yet", () => {
  const order = { customer_id: 0, status: "pending", total: "50.00", billing: { email: "shopper@example.com" } };
  assert.equal(decide(order, customer(), null)[0], "skip");
});

test("no_account when no customers found", () => {
  const order = { customer_id: 0, status: "processing", total: "50.00", billing: { email: "nobody@example.com" } };
  assert.equal(decide(order, [], intent())[0], "no_account");
});

test("ambiguous when multiple accounts share email", () => {
  const order = { customer_id: 0, status: "processing", total: "50.00", billing: { email: "shopper@example.com" } };
  const two = [...customer(1), ...customer(2)];
  assert.equal(decide(order, two, intent())[0], "ambiguous");
});

test("unverified when no intent saved", () => {
  const order = { customer_id: 0, status: "processing", total: "50.00", billing: { email: "shopper@example.com" } };
  assert.equal(decide(order, customer(), null)[0], "unverified");
});

test("unverified when intent not succeeded", () => {
  const order = { customer_id: 0, status: "processing", total: "50.00", billing: { email: "shopper@example.com" } };
  assert.equal(decide(order, customer(), intent({ status: "requires_action" }))[0], "unverified");
});

test("unverified when amount mismatch", () => {
  const order = { customer_id: 0, status: "processing", total: "80.00", billing: { email: "shopper@example.com" } };
  assert.equal(decide(order, customer(), intent())[0], "unverified");
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
  assert.equal(orderAmountMinor({ total: "19.99" }), 1999);
});
