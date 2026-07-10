import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeclined } from "./fail-declined.js";

test("declined when error present", () => {
  assert.equal(isDeclined({ status: "requires_payment_method", last_payment_error: { code: "card_declined" } }), true);
});

test("not declined without error", () => {
  assert.equal(isDeclined({ status: "requires_payment_method", last_payment_error: null }), false);
});

test("not declined when waiting on 3ds", () => {
  assert.equal(isDeclined({ status: "requires_action", last_payment_error: null }), false);
});

test("not declined when succeeded", () => {
  assert.equal(isDeclined({ status: "succeeded" }), false);
});
