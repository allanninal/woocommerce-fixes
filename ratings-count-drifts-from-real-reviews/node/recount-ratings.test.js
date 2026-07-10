import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, realRatingStats } from "./recount-ratings.js";

const review = (rating) => ({ rating });

test("skip when count and average match", () => {
  const product = { rating_count: 3, average_rating: "4.33" };
  const { count, average } = realRatingStats([review(4), review(4), review(5)]);
  assert.equal(decide(product, count, average)[0], "skip");
});

test("recompute when count is stale", () => {
  const product = { rating_count: 312, average_rating: "4.8" };
  const { count, average } = realRatingStats([review(5), review(4)]);
  const [action, reason] = decide(product, count, average);
  assert.equal(action, "recompute");
  assert.match(reason, /rating_count/);
});

test("recompute when average is stale but count matches", () => {
  const product = { rating_count: 2, average_rating: "5.0" };
  const { count, average } = realRatingStats([review(1), review(1)]);
  const [action, reason] = decide(product, count, average);
  assert.equal(action, "recompute");
  assert.match(reason, /average_rating/);
});

test("skip within rounding tolerance", () => {
  const product = { rating_count: 3, average_rating: "4.3" };
  const { count, average } = realRatingStats([review(4), review(4), review(5)]);
  assert.equal(decide(product, count, average)[0], "skip");
});

test("recompute when no rated reviews left but count still stored", () => {
  const product = { rating_count: 5, average_rating: "4.0" };
  const { count, average } = realRatingStats([{ rating: null }, { rating: 0 }]);
  const [action] = decide(product, count, average);
  assert.equal(action, "recompute");
  assert.equal(count, 0);
  assert.equal(average, 0);
});

test("realRatingStats ignores unrated comments", () => {
  const { count, average } = realRatingStats([review(5), { rating: null }, review(3)]);
  assert.equal(count, 2);
  assert.equal(average, 4);
});
