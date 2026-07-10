import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, cartHasItems, daysSince } from "./clear-stale-carts.js";

const cartMeta = (over = {}) => ({
  key: "_woocommerce_persistent_cart_1",
  value: { cart: { abc123: { quantity: 1 } } },
  ...over,
});

test("clear when quiet past threshold", () => {
  assert.equal(decide(cartMeta(), 200, 180)[0], "clear");
});

test("clear reason mentions days", () => {
  const [action, reason] = decide(cartMeta(), 200, 180);
  assert.equal(action, "clear");
  assert.ok(reason.includes("200") && reason.includes("180"));
});

test("skip when no meta", () => {
  assert.equal(decide(null, 200, 180)[0], "skip");
});

test("skip when cart is empty", () => {
  assert.equal(decide(cartMeta({ value: { cart: {} } }), 200, 180)[0], "skip");
});

test("skip when cart value missing", () => {
  assert.equal(decide(cartMeta({ value: "" }), 200, 180)[0], "skip");
});

test("skip when not quiet long enough", () => {
  assert.equal(decide(cartMeta(), 30, 180)[0], "skip");
});

test("skip when just under threshold", () => {
  assert.equal(decide(cartMeta(), 179, 180)[0], "skip");
});

test("clear when exactly at threshold", () => {
  assert.equal(decide(cartMeta(), 180, 180)[0], "clear");
});

test("skip when days quiet is null", () => {
  assert.equal(decide(cartMeta(), null, 180)[0], "skip");
});

test("cartHasItems true for real cart", () => {
  assert.equal(cartHasItems(cartMeta()), true);
});

test("cartHasItems false for null", () => {
  assert.equal(cartHasItems(null), false);
});

test("cartHasItems false for empty dict value", () => {
  assert.equal(cartHasItems({ value: { cart: {} } }), false);
});

test("daysSince returns null for falsy date", () => {
  assert.equal(daysSince(null), null);
  assert.equal(daysSince(""), null);
});

test("daysSince returns a number for a past date", () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
  const result = daysSince(tenDaysAgo);
  assert.ok(result >= 9 && result <= 10);
});
