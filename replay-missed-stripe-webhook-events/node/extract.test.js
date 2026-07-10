import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAction } from "./replay-events.js";

const event = (t, orderId = "42") => ({
  id: "evt_1", type: t, data: { object: { id: "pi_1", metadata: { order_id: orderId } } },
});

test("complete from succeeded", () => {
  assert.equal(extractAction(event("payment_intent.succeeded")).action, "complete");
});

test("refund from charge refunded", () => {
  assert.equal(extractAction(event("charge.refunded")).action, "refund");
});

test("none for unknown type", () => {
  assert.equal(extractAction(event("customer.created")), null);
});

test("none without order id", () => {
  assert.equal(extractAction({ id: "evt_2", type: "payment_intent.succeeded", data: { object: { metadata: {} } } }), null);
});
