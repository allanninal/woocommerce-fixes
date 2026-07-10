import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./recreate-subs.js";

const sub = (over = {}) => ({
  status: "active",
  _stripe_customer_id: "cus_old1",
  _stripe_source_id: "pm_old1",
  ...over,
});

const token = (over = {}) => ({
  customerId: "cus_new1",
  paymentMethodId: "pm_new1",
  chargeable: true,
  ...over,
});

test("recreate when new token available", () => {
  assert.equal(decide(sub(), token())[0], "recreate");
});

test("skip when subscription not active", () => {
  assert.equal(decide(sub({ status: "cancelled" }), token())[0], "skip");
});

test("recreate still considered when on-hold", () => {
  assert.equal(decide(sub({ status: "on-hold" }), token())[0], "recreate");
});

test("missing when no new token yet", () => {
  assert.equal(decide(sub(), null)[0], "missing");
});

test("missing when token not chargeable", () => {
  assert.equal(decide(sub(), token({ chargeable: false }))[0], "missing");
});

test("skip when already pointing at current token", () => {
  const current = sub({ _stripe_customer_id: "cus_new1", _stripe_source_id: "pm_new1" });
  assert.equal(decide(current, token())[0], "skip");
});

test("skip when no old customer recorded", () => {
  assert.equal(decide(sub({ _stripe_customer_id: null }), token())[0], "skip");
});
