# Products stranded with no category

A product with an empty categories array cannot be found through category pages, menu links, or any widget that filters by category. It still has a direct URL and still shows in search, so it quietly keeps selling while being invisible everywhere a browsing shopper would normally find it. This job walks published WooCommerce products, flags the ones with zero categories, and assigns a configured fallback category so the product is reachable again. It also checks recent Stripe PaymentIntents so a product that is actively selling gets called out with higher urgency in the log.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/products-stranded-with-no-category/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export FALLBACK_CATEGORY_ID="15"
export LOOKBACK_HOURS="24"
export DRY_RUN="true"

python products-stranded-with-no-category/python/assign_fallback_category.py
node   products-stranded-with-no-category/node/assign-fallback-category.js
```

`decide` is a pure function: a product is fixed only when it is published and has zero categories, and only when a `FALLBACK_CATEGORY_ID` is configured to assign. It never touches a product that already has a category. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest products-stranded-with-no-category/python
node --test products-stranded-with-no-category/node/assign-fallback-category.test.js
```
