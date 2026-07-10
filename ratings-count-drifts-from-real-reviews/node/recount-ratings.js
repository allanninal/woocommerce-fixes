/**
 * Recompute a product's rating average and count from real approved reviews.
 *
 * WooCommerce caches a product's rating in two places: the `average_rating`
 * and `rating_count` fields the REST API reports, backed by the
 * `_wc_average_rating` and `_wc_review_count` (also read as
 * `_wc_rating_count`) postmeta. That cache is meant to be rebuilt every time
 * a review is approved, held, or deleted, but a bulk import, a moderation
 * plugin, a direct database edit, or a crash mid request can leave it stale.
 * Support then sees a product showing "4.8 (312)" while the actual approved
 * reviews with a star rating add up to something else entirely.
 *
 * This script walks products, asks the WooCommerce REST API for every
 * approved review that carries a rating, recomputes the true average and
 * count, and compares that against what the product currently reports. When
 * they disagree it writes the corrected numbers back as product meta, the
 * same fields WooCommerce itself uses to cache the count. Read only by
 * default. Safe to run again and again, since a product that is already
 * correct is left untouched.
 *
 * Guide: https://www.allanninal.dev/woocommerce/ratings-count-drifts-from-real-reviews/
 */
import { pathToFileURL } from "node:url";

const WOO_URL = (process.env.WOO_STORE_URL || "https://example.com").replace(/\/$/, "");
const AUTH = "Basic " + Buffer.from(
  `${process.env.WOO_CONSUMER_KEY || "ck_dummy"}:${process.env.WOO_CONSUMER_SECRET || "cs_dummy"}`
).toString("base64");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Anything above this is not worth flagging, floating point rounding on the
// stored average is common and is not a real drift.
const RATING_TOLERANCE = 0.05;

/**
 * Fold a list of approved review objects into { count, average }.
 *
 * Only reviews that carry a star rating of 1 to 5 count towards the total.
 * A review left with no rating (a plain comment) does not move the average,
 * the same rule WooCommerce itself applies when it rebuilds the cache.
 */
export function realRatingStats(reviews) {
  const rated = reviews.map((r) => r.rating).filter((r) => Boolean(r));
  const count = rated.length;
  if (count === 0) return { count: 0, average: 0 };
  const average = Math.round((rated.reduce((a, b) => a + b, 0) / count) * 100) / 100;
  return { count, average };
}

/**
 * Pure decision: does this product's cached rating need a rewrite?
 *
 * Returns ["skip" | "recompute", reason]. No I/O happens here, so this is
 * fully unit testable with plain objects.
 */
export function decide(product, realCount, realAverage) {
  const storedCount = Number(product.rating_count || 0);
  const storedAverage = Number(product.average_rating || 0);

  if (storedCount === realCount && Math.abs(storedAverage - realAverage) <= RATING_TOLERANCE) {
    return ["skip", "rating count and average already match approved reviews"];
  }

  if (storedCount !== realCount) {
    return [
      "recompute",
      `rating_count is ${storedCount} but ${realCount} approved review(s) have a star rating`,
    ];
  }

  return ["recompute", `average_rating is ${storedAverage} but real average is ${realAverage}`];
}

async function woo(path, options = {}) {
  const res = await fetch(`${WOO_URL}/wp-json/wc/v3${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: AUTH, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Woo ${path} returned ${res.status}`);
  return res.json();
}

async function* listProducts(perPage = 50) {
  let page = 1;
  while (true) {
    const batch = await woo(`/products?per_page=${perPage}&page=${page}&status=publish`);
    if (!batch.length) return;
    for (const product of batch) yield product;
    page++;
  }
}

async function* approvedReviewsFor(productId, perPage = 100) {
  let page = 1;
  while (true) {
    const batch = await woo(
      `/products/reviews?product=${productId}&status=approved&per_page=${perPage}&page=${page}`
    );
    if (!batch.length) return;
    for (const review of batch) yield review;
    page++;
  }
}

async function applyRecount(productId, realCount, realAverage) {
  await woo(`/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify({
      meta_data: [
        { key: "_wc_review_count", value: String(realCount) },
        { key: "_wc_rating_count", value: String(realCount) },
        { key: "_wc_average_rating", value: realAverage.toFixed(2) },
      ],
    }),
  });
}

export async function run() {
  let fixed = 0;
  for await (const product of listProducts()) {
    const reviews = [];
    for await (const review of approvedReviewsFor(product.id)) reviews.push(review);
    const { count: realCount, average: realAverage } = realRatingStats(reviews);
    const [action, reason] = decide(product, realCount, realAverage);
    if (action === "skip") continue;
    console.log(
      `Product ${product.id} (${product.name || ""}): ${reason}. ${DRY_RUN ? "would recompute" : "recomputing"}`
    );
    if (!DRY_RUN) await applyRecount(product.id, realCount, realAverage);
    fixed++;
  }
  console.log(`Done. ${fixed} product(s) ${DRY_RUN ? "to recompute" : "recomputed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
