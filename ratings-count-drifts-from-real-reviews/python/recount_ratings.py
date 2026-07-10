"""Recompute a product's rating average and count from real approved reviews.

WooCommerce caches a product's rating in two places: the `average_rating` and
`rating_count` fields the REST API reports, backed by the `_wc_average_rating`
and `_wc_review_count` (also read as `_wc_rating_count`) postmeta. That cache
is meant to be rebuilt every time a review is approved, held, or deleted, but a
bulk import, a moderation plugin, a direct database edit, or a crash mid
request can leave it stale. Support then sees a product showing "4.8 (312)"
while the actual approved reviews with a star rating add up to something else
entirely.

This script walks products, asks the WooCommerce REST API for every approved
review that carries a rating, recomputes the true average and count, and
compares that against what the product currently reports. When they disagree
it writes the corrected numbers back as product meta, the same fields
WooCommerce itself uses to cache the count. Read only by default. Safe to run
again and again, since a product that is already correct is left untouched.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recount_ratings")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Anything above this is not worth flagging, floating point rounding on the
# stored average is common and is not a real drift.
RATING_TOLERANCE = 0.05


def real_rating_stats(reviews):
    """Fold a list of approved review objects into (count, average).

    Only reviews that carry a star rating of 1 to 5 count towards the total.
    A review left with no rating (a plain comment) does not move the average,
    the same rule WooCommerce itself applies when it rebuilds the cache.
    """
    rated = [r["rating"] for r in reviews if r.get("rating")]
    count = len(rated)
    if count == 0:
        return 0, 0.0
    average = sum(rated) / count
    return count, round(average, 2)


def decide(product, real_count, real_average):
    """Pure decision: does this product's cached rating need a rewrite?

    Returns a tuple of (action, reason). action is one of:
      "skip"      - the cached numbers already match the real reviews
      "recompute" - the cache is stale and should be corrected
    No I/O happens here, so this is fully unit testable with plain dicts.
    """
    stored_count = int(product.get("rating_count") or 0)
    stored_average = float(product.get("average_rating") or 0)

    if stored_count == real_count and abs(stored_average - real_average) <= RATING_TOLERANCE:
        return ("skip", "rating count and average already match approved reviews")

    if stored_count != real_count:
        return (
            "recompute",
            f"rating_count is {stored_count} but {real_count} approved review(s) have a star rating",
        )

    return (
        "recompute",
        f"average_rating is {stored_average} but real average is {real_average}",
    )


def list_products(per_page=50):
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products",
            params={"per_page": per_page, "page": page, "status": "publish"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for product in batch:
            yield product
        page += 1


def approved_reviews_for(product_id, per_page=100):
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products/reviews",
            params={"product": product_id, "status": "approved", "per_page": per_page, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for review in batch:
            yield review
        page += 1


def apply_recount(product_id, real_count, real_average):
    """Write the corrected numbers using the same postmeta WooCommerce reads."""
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json={
            "meta_data": [
                {"key": "_wc_review_count", "value": str(real_count)},
                {"key": "_wc_rating_count", "value": str(real_count)},
                {"key": "_wc_average_rating", "value": f"{real_average:.2f}"},
            ]
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for product in list_products():
        reviews = list(approved_reviews_for(product["id"]))
        real_count, real_average = real_rating_stats(reviews)
        action, reason = decide(product, real_count, real_average)
        if action == "skip":
            continue
        log.info(
            "Product %s (%s): %s. %s",
            product["id"], product.get("name", ""), reason, "would recompute" if DRY_RUN else "recomputing",
        )
        if not DRY_RUN:
            apply_recount(product["id"], real_count, real_average)
        fixed += 1
    log.info("Done. %d product(s) %s.", fixed, "to recompute" if DRY_RUN else "recomputed")


if __name__ == "__main__":
    run()
