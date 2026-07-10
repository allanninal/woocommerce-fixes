import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  isRenewalOrder,
  badCouponsOnOrder,
  discountMinorOf,
  moneyToMinor,
} from "./strip-bad-renewal-coupons.js";

const renewalOrder = (over = {}) => ({
  status: "processing",
  meta_data: [{ key: "_subscription_renewal", value: "123" }],
  coupon_lines: [],
  ...over,
});

test("fix when a one time coupon is on a renewal", () => {
  const order = renewalOrder({ coupon_lines: [{ id: 1, code: "WELCOME10", discount: "5.00" }] });
  const types = { welcome10: "percent" };
  const [action, , bad] = decide(order, types);
  assert.equal(action, "fix");
  assert.equal(bad.length, 1);
});

test("skip when the coupon is a recurring type", () => {
  const order = renewalOrder({ coupon_lines: [{ id: 2, code: "LOYAL5", discount: "5.00" }] });
  const types = { loyal5: "recurring_percent" };
  assert.equal(decide(order, types)[0], "skip");
});

test("skip when the order is not a renewal", () => {
  const order = { status: "processing", meta_data: [], coupon_lines: [{ id: 3, code: "WELCOME10", discount: "5.00" }] };
  const types = { welcome10: "percent" };
  assert.equal(decide(order, types)[0], "skip");
});

test("skip when there are no coupons on the order", () => {
  assert.equal(decide(renewalOrder(), {})[0], "skip");
});

test("skip when the order is cancelled", () => {
  const order = renewalOrder({ status: "cancelled", coupon_lines: [{ id: 4, code: "WELCOME10", discount: "5.00" }] });
  const types = { welcome10: "percent" };
  assert.equal(decide(order, types)[0], "skip");
});

test("skip when the coupon code is unknown", () => {
  const order = renewalOrder({ coupon_lines: [{ id: 5, code: "GONE", discount: "5.00" }] });
  assert.equal(decide(order, {})[0], "skip");
});

test("isRenewalOrder true and false", () => {
  assert.equal(isRenewalOrder(renewalOrder()), true);
  assert.equal(isRenewalOrder({ meta_data: [] }), false);
});

test("badCouponsOnOrder filters by discount type", () => {
  const order = renewalOrder({
    coupon_lines: [
      { id: 6, code: "ONE", discount: "3.00" },
      { id: 7, code: "TWO", discount: "4.00" },
    ],
  });
  const types = { one: "fixed_cart", two: "recurring_fixed_cart" };
  const bad = badCouponsOnOrder(order, types);
  assert.deepEqual(bad.map((b) => b.id), [6]);
});

test("discountMinorOf sums in cents", () => {
  assert.equal(discountMinorOf([{ discount: "5.00" }, { discount: "2.50" }]), 750);
});

test("moneyToMinor rounds to cents", () => {
  assert.equal(moneyToMinor("19.999"), 2000);
  assert.equal(moneyToMinor("0"), 0);
});
