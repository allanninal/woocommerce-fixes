import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, saleWindowOf, parseGmt } from "./revert-expired-sales.js";

const NOW = new Date("2026-07-10T12:00:00Z");

const win = (over = {}) => ({
  salePrice: "19.00",
  regularPrice: "29.00",
  endsAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

test("revert when end date passed", () => {
  assert.equal(decide(win(), NOW)[0], "revert");
});

test("skip when no sale price", () => {
  assert.equal(decide(win({ salePrice: "" }), NOW)[0], "skip");
});

test("skip when no end date", () => {
  assert.equal(decide(win({ endsAt: null }), NOW)[0], "skip");
});

test("skip when end date in future", () => {
  assert.equal(decide(win({ endsAt: new Date("2026-08-01T00:00:00Z") }), NOW)[0], "skip");
});

test("revert when end date is exactly now", () => {
  assert.equal(decide(win({ endsAt: NOW }), NOW)[0], "revert");
});

test("parseGmt returns null when missing", () => {
  assert.equal(parseGmt(""), null);
  assert.equal(parseGmt(null), null);
});

test("parseGmt parses a naive string as UTC", () => {
  assert.equal(parseGmt("2026-07-01T00:00:00").toISOString(), "2026-07-01T00:00:00.000Z");
});

test("saleWindowOf reads expected fields", () => {
  const product = {
    sale_price: "19.00",
    regular_price: "29.00",
    date_on_sale_to_gmt: "2026-07-01T00:00:00",
  };
  const out = saleWindowOf(product);
  assert.equal(out.salePrice, "19.00");
  assert.equal(out.regularPrice, "29.00");
  assert.equal(out.endsAt.toISOString(), "2026-07-01T00:00:00.000Z");
});

test("saleWindowOf defaults when fields are missing", () => {
  const out = saleWindowOf({});
  assert.equal(out.salePrice, "");
  assert.equal(out.regularPrice, "");
  assert.equal(out.endsAt, null);
});
