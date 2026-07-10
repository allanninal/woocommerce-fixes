import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, intentIdOf, orderTotalMinor, toMajorStr } from "./sync-partial-capture.js";

const intent = (over = {}) => ({ id: "pi_1", status: "succeeded", amount_received: 5000, amount_capturable: 0, ...over });
const order = (over = {}) => ({ status: "processing", total: "80.00", ...over });

test("fix when captured less than order total", () => {
  const [action, reason] = decide(order({ total: "80.00" }), intent({ amount_received: 5000 }));
  assert.equal(action, "fix");
  assert.match(reason, /5000/);
});

test("ok when captured matches order total", () => {
  const [action] = decide(order({ total: "50.00" }), intent({ amount_received: 5000 }));
  assert.equal(action, "ok");
});

test("ok within one cent tolerance", () => {
  const [action] = decide(order({ total: "50.00" }), intent({ amount_received: 4999 }));
  assert.equal(action, "ok");
});

test("skip when order not paid", () => {
  const [action] = decide(order({ status: "pending" }), intent());
  assert.equal(action, "skip");
});

test("skip when no intent", () => {
  const [action] = decide(order(), null);
  assert.equal(action, "skip");
});

test("skip when intent status not relevant", () => {
  const [action] = decide(order(), intent({ status: "canceled" }));
  assert.equal(action, "skip");
});

test("skip when capture still in progress", () => {
  const [action, reason] = decide(order(), intent({ amount_capturable: 1500 }));
  assert.equal(action, "skip");
  assert.match(reason, /in progress/);
});

test("flag when order total lower than charge", () => {
  const [action, reason] = decide(order({ total: "40.00" }), intent({ amount_received: 5000 }));
  assert.equal(action, "flag");
  assert.match(reason, /lower/);
});

test("requires_capture status is evaluated", () => {
  const [action] = decide(
    order({ total: "80.00" }),
    intent({ status: "requires_capture", amount_received: 0, amount_capturable: 0 })
  );
  assert.equal(action, "fix");
});

test("orderTotalMinor converts correctly", () => {
  assert.equal(orderTotalMinor({ total: "19.99" }), 1999);
});

test("toMajorStr round trips", () => {
  assert.equal(toMajorStr(5000), "50.00");
  assert.equal(toMajorStr(1999), "19.99");
});

test("intentIdOf from meta", () => {
  assert.equal(intentIdOf({ meta_data: [{ key: "_stripe_intent_id", value: "pi_123" }], transaction_id: "" }), "pi_123");
});

test("intentIdOf falls back to transaction_id", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "pi_456" }), "pi_456");
});

test("intentIdOf null when transaction is a charge", () => {
  assert.equal(intentIdOf({ meta_data: [], transaction_id: "ch_789" }), null);
});
