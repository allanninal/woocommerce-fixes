import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./restore-paid.js";

const intent = (over = {}) => ({ status: "succeeded", amount_received: 5000, id: "pi_1", ...over });

test("restore when failed but paid", () => {
  assert.equal(decide({ status: "failed", total: "50.00" }, intent())[0], "restore");
});

test("restore when cancelled but paid", () => {
  assert.equal(decide({ status: "cancelled", total: "50.00" }, intent())[0], "restore");
});

test("skip when order already processing", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent())[0], "skip");
});

test("mismatch when amount differs", () => {
  assert.equal(decide({ status: "failed", total: "40.00" }, intent())[0], "mismatch");
});

test("orphan when order missing", () => {
  assert.equal(decide(null, intent())[0], "orphan");
});
