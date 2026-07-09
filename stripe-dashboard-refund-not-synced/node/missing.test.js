import { test } from "node:test";
import assert from "node:assert/strict";
import { missingRefundMinor } from "./sync-refunds.js";

test("records full amount when woo has none", () => {
  assert.equal(missingRefundMinor(5000, []), 5000);
});

test("nothing missing when amounts match", () => {
  assert.equal(missingRefundMinor(5000, [{ amount: "50.00" }]), 0);
});

test("records only the gap", () => {
  assert.equal(missingRefundMinor(5000, [{ amount: "20.00" }]), 3000);
});
