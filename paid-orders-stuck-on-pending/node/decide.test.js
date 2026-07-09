import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./reconcile-pending.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, id: "pi_1", ...over });

test("fix when pending and paid", () => {
  assert.equal(decide({ status: "pending", total: "50.00" }, intent())[0], "fix");
});

test("skip when already processing", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent())[0], "skip");
});

test("mismatch when amount differs", () => {
  assert.equal(decide({ status: "pending", total: "40.00" }, intent())[0], "mismatch");
});

test("orphan when order missing", () => {
  assert.equal(decide(null, intent())[0], "orphan");
});
