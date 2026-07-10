import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, stripeIdsOf, productAmountMinor } from "./sync-products-to-stripe.js";

const product = (over = {}) => ({
  id: 42, name: "Pro Plan", status: "publish", type: "subscription", price: "50.00", ...over,
});
const stripeProduct = (over = {}) => ({ id: "prod_1", active: true, ...over });
const stripePrice = (over = {}) => ({ id: "price_1", active: true, unit_amount: 5000, ...over });

test("create_both when no stripe product", () => {
  assert.equal(decide(product(), null, null)[0], "create_both");
});

test("create_both when stripe product archived", () => {
  assert.equal(decide(product(), stripeProduct({ active: false }), stripePrice())[0], "create_both");
});

test("create_price when price missing", () => {
  assert.equal(decide(product(), stripeProduct(), null)[0], "create_price");
});

test("create_price when price archived", () => {
  assert.equal(decide(product(), stripeProduct(), stripePrice({ active: false }))[0], "create_price");
});

test("create_price when amount changed", () => {
  assert.equal(decide(product({ price: "60.00" }), stripeProduct(), stripePrice())[0], "create_price");
});

test("ok when already in sync", () => {
  assert.equal(decide(product(), stripeProduct(), stripePrice())[0], "ok");
});

test("skip when not published", () => {
  assert.equal(decide(product({ status: "draft" }), null, null)[0], "skip");
});

test("skip when type not syncable", () => {
  assert.equal(decide(product({ type: "grouped" }), null, null)[0], "skip");
});

test("skip when no price yet", () => {
  assert.equal(decide(product({ price: "0" }), null, null)[0], "skip");
});

test("stripeIdsOf reads meta", () => {
  const p = product({
    meta_data: [
      { key: "_stripe_product_id", value: "prod_9" },
      { key: "_stripe_price_id", value: "price_9" },
    ],
  });
  assert.deepEqual(stripeIdsOf(p), ["prod_9", "price_9"]);
});

test("stripeIdsOf missing meta", () => {
  assert.deepEqual(stripeIdsOf(product()), [null, null]);
});

test("productAmountMinor uses price then regular_price", () => {
  assert.equal(productAmountMinor(product({ price: "19.99" })), 1999);
  assert.equal(productAmountMinor({ regular_price: "19.99" }), 1999);
});
