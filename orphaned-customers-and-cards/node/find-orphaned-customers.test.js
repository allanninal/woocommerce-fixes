import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./find-orphaned-customers.js";

const customer = (over = {}) => ({
  id: "cus_1",
  deleted: false,
  metadata: {},
  has_active_subscription: false,
  has_payment_method: false,
  ...over,
});

const wooUser = (over = {}) => ({ id: 42, email: "buyer@example.com", ...over });

test("ok when customer and user agree", () => {
  assert.equal(decide(customer(), wooUser())[0], "ok");
});

test("broken-link when customer missing", () => {
  assert.equal(decide(null, null)[0], "broken-link");
});

test("broken-link when customer deleted", () => {
  assert.equal(decide(customer({ deleted: true }), null)[0], "broken-link");
});

test("reconnect when metadata points elsewhere", () => {
  const [action] = decide(customer({ metadata: { woo_customer_id: "99" } }), wooUser({ id: 42 }));
  assert.equal(action, "reconnect");
});

test("reconnect when metadata names missing user", () => {
  const [action] = decide(customer({ metadata: { woo_customer_id: "99" } }), null);
  assert.equal(action, "reconnect");
});

test("orphan when nothing claims it and nothing attached", () => {
  assert.equal(decide(customer(), null)[0], "orphan");
});

test("keep when orphan has active subscription", () => {
  const [action] = decide(customer({ has_active_subscription: true }), null);
  assert.equal(action, "keep");
});

test("keep when orphan has saved payment method", () => {
  const [action] = decide(customer({ has_payment_method: true }), null);
  assert.equal(action, "keep");
});
