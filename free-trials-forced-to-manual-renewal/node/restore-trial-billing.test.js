import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, stripeCustomerId } from "./restore-trial-billing.js";

const card = (over = {}) => ({ id: "pm_1", ...over });

test("restore when manual and card found", () => {
  assert.equal(decide({ requires_manual_renewal: true }, card())[0], "restore");
});

test("skip when already automatic", () => {
  assert.equal(decide({ requires_manual_renewal: false }, card())[0], "skip");
});

test("skip when no payment method", () => {
  assert.equal(decide({ requires_manual_renewal: true }, null)[0], "skip");
});

test("skip reason mentions no card when none found", () => {
  const [, reason] = decide({ requires_manual_renewal: true }, null);
  assert.match(reason, /no reusable payment method/);
});

test("restore reason mentions usable card", () => {
  const [, reason] = decide({ requires_manual_renewal: true }, card());
  assert.match(reason, /usable card/);
});

test("stripeCustomerId reads from meta_data", () => {
  const sub = { meta_data: [{ key: "_stripe_customer_id", value: "cus_123" }] };
  assert.equal(stripeCustomerId(sub), "cus_123");
});

test("stripeCustomerId returns null when missing", () => {
  assert.equal(stripeCustomerId({ meta_data: [] }), null);
});
