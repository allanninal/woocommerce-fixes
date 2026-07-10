import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, shouldBeOnSale, toMinor, withinSaleWindow } from "./recompute-on-sale.js";

const NOW = new Date("2026-07-10T12:00:00Z");

const product = (over = {}) => ({
  regular_price: "50.00",
  sale_price: "40.00",
  date_on_sale_from: null,
  date_on_sale_to: null,
  on_sale: false,
  ...over,
});

test("fix when should be on sale but flag is false", () => {
  const p = product({ on_sale: false });
  assert.equal(shouldBeOnSale(p, NOW), true);
  assert.equal(decide(p, NOW)[0], "fix");
});

test("skip when flag already matches on sale", () => {
  assert.equal(decide(product({ on_sale: true }), NOW)[0], "skip");
});

test("skip when flag already matches not on sale", () => {
  assert.equal(decide(product({ sale_price: "", on_sale: false }), NOW)[0], "skip");
});

test("fix when sale window has passed but flag still true", () => {
  const p = product({ date_on_sale_to: "2026-01-01T00:00:00Z", on_sale: true });
  assert.equal(shouldBeOnSale(p, NOW), false);
  assert.equal(decide(p, NOW)[0], "fix");
});

test("fix when sale price not below regular but flag true", () => {
  const p = product({ sale_price: "50.00", on_sale: true });
  assert.equal(shouldBeOnSale(p, NOW), false);
  assert.equal(decide(p, NOW)[0], "fix");
});

test("fix when sale price above regular but flag true", () => {
  const p = product({ sale_price: "60.00", on_sale: true });
  assert.equal(shouldBeOnSale(p, NOW), false);
  assert.equal(decide(p, NOW)[0], "fix");
});

test("skip when sale starts in the future and flag false", () => {
  const p = product({ date_on_sale_from: "2026-08-01T00:00:00Z", on_sale: false });
  assert.equal(shouldBeOnSale(p, NOW), false);
  assert.equal(decide(p, NOW)[0], "skip");
});

test("fix when sale starts in the future but flag true", () => {
  const p = product({ date_on_sale_from: "2026-08-01T00:00:00Z", on_sale: true });
  assert.equal(shouldBeOnSale(p, NOW), false);
  assert.equal(decide(p, NOW)[0], "fix");
});

test("skip when no regular price", () => {
  assert.equal(decide(product({ regular_price: "", on_sale: false }), NOW)[0], "skip");
});

test("withinSaleWindow true with no bounds", () => {
  assert.equal(withinSaleWindow(null, null, NOW), true);
});

test("withinSaleWindow false before start", () => {
  assert.equal(withinSaleWindow("2026-08-01T00:00:00Z", null, NOW), false);
});

test("toMinor handles empty and null", () => {
  assert.equal(toMinor(""), null);
  assert.equal(toMinor(null), null);
  assert.equal(toMinor("19.99"), 1999);
});
