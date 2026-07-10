import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, expectedTerms } from "./repair-visibility-terms.js";

const product = (over = {}) => ({
  id: 1, catalog_visibility: "visible", featured: false, stock_status: "instock", ...over,
});

test("ok when terms match visible product", () => {
  assert.equal(decide(product(), [])[0], "ok");
});

test("repair when hidden but no exclude terms", () => {
  assert.equal(decide(product({ catalog_visibility: "hidden" }), [])[0], "repair");
});

test("ok when hidden and both exclude terms present", () => {
  assert.equal(
    decide(product({ catalog_visibility: "hidden" }), ["exclude-from-search", "exclude-from-catalog"])[0],
    "ok"
  );
});

test("repair when featured flag true but term missing", () => {
  assert.equal(decide(product({ featured: true }), [])[0], "repair");
});

test("repair when featured term present but flag false", () => {
  assert.equal(decide(product({ featured: false }), ["featured"])[0], "repair");
});

test("repair when out of stock but term missing", () => {
  assert.equal(decide(product({ stock_status: "outofstock" }), [])[0], "repair");
});

test("ok when catalog only has exclude-from-search", () => {
  assert.equal(decide(product({ catalog_visibility: "catalog" }), ["exclude-from-search"])[0], "ok");
});

test("repair when search only missing exclude-from-catalog", () => {
  assert.equal(decide(product({ catalog_visibility: "search" }), [])[0], "repair");
});

test("skip when catalog_visibility unrecognized", () => {
  assert.equal(decide(product({ catalog_visibility: "whoops" }), [])[0], "skip");
});

test("expectedTerms for hidden, featured, out of stock", () => {
  const p = product({ catalog_visibility: "hidden", featured: true, stock_status: "outofstock" });
  const terms = expectedTerms(p);
  assert.deepEqual([...terms].sort(), ["exclude-from-catalog", "exclude-from-search", "featured", "outofstock"]);
});

test("expectedTerms for plain visible product is empty", () => {
  assert.equal(expectedTerms(product()).size, 0);
});
