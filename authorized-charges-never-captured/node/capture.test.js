import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./capture-authorized.js";

const intent = (over = {}) => ({ status: "requires_capture", amount: 5000, id: "pi_1", ...over });

test("capture when on hold and amount matches", () => {
  assert.equal(decide({ status: "on-hold", total: "50.00" }, intent())[0], "capture");
});

test("skip when intent not awaiting capture", () => {
  assert.equal(decide({ status: "on-hold", total: "50.00" }, intent({ status: "succeeded" }))[0], "skip");
});

test("skip when order already processing", () => {
  assert.equal(decide({ status: "processing", total: "50.00" }, intent())[0], "skip");
});

test("mismatch when amount differs", () => {
  assert.equal(decide({ status: "on-hold", total: "40.00" }, intent())[0], "mismatch");
});

test("orphan when order missing", () => {
  assert.equal(decide(null, intent())[0], "orphan");
});
