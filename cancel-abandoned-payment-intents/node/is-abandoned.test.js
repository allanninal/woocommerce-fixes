import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbandoned } from "./cancel-abandoned.js";

test("abandoned when old and no error", () => {
  assert.equal(isAbandoned({ status: "requires_payment_method" }, 24, 12), true);
});

test("not abandoned when recent", () => {
  assert.equal(isAbandoned({ status: "requires_payment_method" }, 2, 12), false);
});

test("not abandoned when declined", () => {
  assert.equal(isAbandoned({ status: "requires_payment_method", last_payment_error: { code: "card_declined" } }, 24, 12), false);
});

test("not abandoned when succeeded", () => {
  assert.equal(isAbandoned({ status: "succeeded" }, 24, 12), false);
});
