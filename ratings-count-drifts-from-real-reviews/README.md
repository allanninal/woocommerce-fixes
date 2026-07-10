# Ratings count drifts from real reviews

A product's star rating and review count are cached numbers, rebuilt from approved reviews whenever WooCommerce processes one. A bulk import, a moderation plugin, a direct database edit, or a crash mid request can leave that cache stale, so the product page shows a rating count and average that no longer match the real approved reviews with a star rating. This job walks published products, recomputes the true count and average from the WooCommerce REST API's reviews endpoint, and rewrites the cached fields only when they disagree with reality.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/ratings-count-drifts-from-real-reviews/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # start safe, change to false to write

python ratings-count-drifts-from-real-reviews/python/recount_ratings.py
node   ratings-count-drifts-from-real-reviews/node/recount-ratings.js
```

`decide` is a pure function: a product is recomputed only when its stored `rating_count` or `average_rating` disagrees with what the approved reviews actually add up to, within a small rounding tolerance. It only ever writes to products that are wrong. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest ratings-count-drifts-from-real-reviews/python
node --test ratings-count-drifts-from-real-reviews/node
```
