import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, refundedBefore } from "./refund-dispute-double-reversal.js";

test("skip when no prior refund", () => {
  const [action, , loss] = decide(5000, 0);
  assert.equal(action, "skip");
  assert.equal(loss, 0);
});

test("double reversal when fully refunded first", () => {
  const [action, , loss] = decide(5000, 5000, 1500);
  assert.equal(action, "double_reversal");
  assert.equal(loss, 6500);
});

test("double reversal uses smaller of dispute and refund", () => {
  const [action, , loss] = decide(5000, 2000, 1500);
  assert.equal(action, "double_reversal");
  assert.equal(loss, 3500);
});

test("double reversal when partial refund covers whole dispute", () => {
  const [action, , loss] = decide(5000, 8000, 1500);
  assert.equal(action, "double_reversal");
  assert.equal(loss, 5000 + 1500);
});

test("default dispute fee is applied", () => {
  const [, , loss] = decide(3000, 3000);
  assert.equal(loss, 3000 + 1500);
});

test("refundedBefore sums only succeeded refunds before cutoff", () => {
  const charge = {
    refunds: {
      data: [
        { status: "succeeded", created: 100, amount: 2000 },
        { status: "succeeded", created: 200, amount: 3000 }, // after cutoff
        { status: "failed", created: 50, amount: 1000 }, // not succeeded
      ],
    },
  };
  assert.equal(refundedBefore(charge, 150), 2000);
});

test("refundedBefore returns zero when no refunds", () => {
  assert.equal(refundedBefore({ refunds: { data: [] } }, 100), 0);
  assert.equal(refundedBefore({}, 100), 0);
});
