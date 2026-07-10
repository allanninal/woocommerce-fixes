import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, productPriceMinor, intentIdOf, orderLineFacts } from "./rebuild-lookup-rows.js";

const fact = (over = {}) => ({ orderTotalMinor: 4500, stripeAmountMinor: 4500, discounted: false, ...over });

test("resave when price steadily mismatched", () => {
  const product = { price: "60.00", purchasable: true, stock_status: "instock", stock_quantity: 5 };
  assert.equal(decide(product, [fact(), fact()])[0], "resave");
});

test("ok when only one mismatch below threshold", () => {
  const product = { price: "60.00", purchasable: true, stock_status: "instock", stock_quantity: 5 };
  assert.equal(decide(product, [fact()], 2)[0], "ok");
});

test("ok when price matches", () => {
  const product = { price: "45.00", purchasable: true, stock_status: "instock", stock_quantity: 5 };
  assert.equal(decide(product, [fact(), fact()])[0], "ok");
});

test("discounted orders are not counted as mismatch", () => {
  const product = { price: "60.00", purchasable: true, stock_status: "instock", stock_quantity: 5 };
  assert.equal(decide(product, [fact({ discounted: true }), fact({ discounted: true })])[0], "ok");
});

test("skip when not purchasable", () => {
  const product = { price: "60.00", purchasable: false, stock_status: "instock", stock_quantity: 5 };
  assert.equal(decide(product, [fact(), fact()])[0], "skip");
});

test("resave when stock says instock with zero quantity", () => {
  const product = { price: "45.00", purchasable: true, stock_status: "instock", stock_quantity: 0 };
  assert.equal(decide(product, [fact()])[0], "resave");
});

test("skip when no recent orders", () => {
  const product = { price: "45.00", purchasable: true, stock_status: "instock", stock_quantity: 5 };
  assert.equal(decide(product, [])[0], "skip");
});

test("mismatch must also match stripe amount", () => {
  // order total disagrees with current price, but also disagrees with the
  // Stripe amount, so this is not evidence of a stale lookup row, it is
  // evidence the order data itself is unreliable, and should not count.
  const product = { price: "60.00", purchasable: true, stock_status: "instock", stock_quantity: 5 };
  const facts = [
    fact({ orderTotalMinor: 4500, stripeAmountMinor: 4999 }),
    fact({ orderTotalMinor: 4500, stripeAmountMinor: 4999 }),
  ];
  assert.equal(decide(product, facts)[0], "ok");
});

test("productPriceMinor rounds correctly", () => {
  assert.equal(productPriceMinor({ price: "19.99" }), 1999);
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

test("orderLineFacts extracts product id, unit price, discount, and quantity", () => {
  const order = {
    line_items: [
      { product_id: 42, price: "45.00", total: "45.00", subtotal: "45.00", quantity: 1 },
      { product_id: 43, price: "10.00", total: "8.00", subtotal: "10.00", quantity: 1 },
      { product_id: null, price: "5.00", total: "5.00", subtotal: "5.00", quantity: 1 },
    ],
  };
  const facts = orderLineFacts(order);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].productId, 42);
  assert.equal(facts[0].discounted, false);
  assert.equal(facts[1].productId, 43);
  assert.equal(facts[1].discounted, true);
});
