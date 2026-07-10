import { test } from "node:test";
import assert from "node:assert/strict";
import { recomputeNetFee, isStale } from "./fix-fee-net.js";

test("recompute subtracts refund", () => {
  const { net, fee } = recomputeNetFee({ net: 4700, fee: 300 }, [{ net: -2000, fee: 0 }]);
  assert.equal(net, 2700);
  assert.equal(fee, 300);
});

test("recompute with refunded fee", () => {
  const { net, fee } = recomputeNetFee({ net: 4700, fee: 300 }, [{ net: -4700, fee: -300 }]);
  assert.equal(net, 0);
  assert.equal(fee, 0);
});

test("stale detects difference", () => {
  assert.equal(isStale(4700, 2700), true);
});

test("not stale within tolerance", () => {
  assert.equal(isStale(2700, 2700), false);
});
