import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, stripeIdsAgree } from "./remap-customers.js";

const order = (over = {}) => ({ id: 482, customer_id: 482, ...over });

test("skip when current customer valid", () => {
  assert.equal(decide(order(), true, [])[0], "skip");
});

test("orphan when no email match", () => {
  assert.equal(decide(order(), false, [])[0], "orphan");
});

test("ambiguous when multiple email matches", () => {
  const users = [{ id: 219 }, { id: 340 }];
  assert.equal(decide(order(), false, users)[0], "ambiguous");
});

test("remap when exactly one match and id differs", () => {
  const users = [{ id: 219 }];
  const [action, reason] = decide(order(), false, users);
  assert.equal(action, "remap");
  assert.ok(reason.includes("219"));
});

test("skip when single match already correct", () => {
  const users = [{ id: 482 }];
  assert.equal(decide(order({ customer_id: 482 }), false, users)[0], "skip");
});

test("stripeIdsAgree when either missing", () => {
  assert.equal(stripeIdsAgree(null, "cus_123"), true);
  assert.equal(stripeIdsAgree("cus_123", null), true);
});

test("stripeIdsAgree when equal", () => {
  assert.equal(stripeIdsAgree("cus_123", "cus_123"), true);
});

test("stripeIdsAgree disagree when different", () => {
  assert.equal(stripeIdsAgree("cus_123", "cus_999"), false);
});
