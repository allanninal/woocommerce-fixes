import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, expectedTaxMinor, toMinor, minorToAmount } from "./reconcile-order-tax.js";

const lineItem = (rateTotals) => ({ taxes: { total: rateTotals } });

const order = (over = {}) => ({
  status: "processing",
  total_tax: "5.00",
  line_items: [],
  shipping_lines: [],
  fee_lines: [],
  ...over,
});

test("ok when tax matches line items", () => {
  const o = order({ total_tax: "5.00", line_items: [lineItem({ 1: "3.00" }), lineItem({ 1: "2.00" })] });
  assert.equal(decide(o)[0], "ok");
});

test("fix when off by one cent", () => {
  // Line items round to 2.50 + 2.49 = 4.99, but the stored total_tax is 5.00.
  const o = order({ total_tax: "5.00", line_items: [lineItem({ 1: "2.495" }), lineItem({ 1: "2.494" })] });
  const [action, reason] = decide(o);
  assert.equal(action, "fix");
  assert.match(reason, /1 cent/);
});

test("review when drift too large", () => {
  const o = order({ total_tax: "8.00", line_items: [lineItem({ 1: "3.00" }), lineItem({ 1: "2.00" })] });
  assert.equal(decide(o)[0], "review");
});

test("skip when order not settled", () => {
  const o = order({ status: "pending", total_tax: "5.00", line_items: [lineItem({ 1: "5.00" })] });
  assert.equal(decide(o)[0], "skip");
});

test("shipping and fee lines are included", () => {
  const o = order({
    total_tax: "6.00",
    line_items: [lineItem({ 1: "3.00" })],
    shipping_lines: [lineItem({ 1: "2.00" })],
    fee_lines: [lineItem({ 1: "1.00" })],
  });
  assert.equal(decide(o)[0], "ok");
});

test("expectedTaxMinor sums multiple rates", () => {
  const o = order({ line_items: [lineItem({ 1: "1.00", 2: "0.50" })] });
  assert.equal(expectedTaxMinor(o), 150);
});

test("toMinor rounds half away from zero", () => {
  assert.equal(toMinor("2.495"), 250);
  assert.equal(toMinor("2.005"), 201);
});

test("minorToAmount round trip", () => {
  assert.equal(minorToAmount(500), "5.00");
  assert.equal(minorToAmount(-3), "-0.03");
  assert.equal(minorToAmount(7), "0.07");
});
