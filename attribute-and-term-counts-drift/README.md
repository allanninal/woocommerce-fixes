# Attribute and term counts drift

WooCommerce caches the number of products behind each attribute term (the count layered navigation and filter widgets show) and only refreshes it through WordPress's own recount hooks. Bulk imports, REST API edits, and stock or status changes often skip those hooks, so the stored count quietly drifts from the real catalog. This job walks every attribute and term, recomputes the true count from published, in-stock products, and writes back only the terms whose stored count is wrong. It also cross-checks recent Stripe sales so a drifted term that is still actively selling gets flagged as higher priority.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/attribute-and-term-counts-drift/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export SALES_LOOKBACK_HOURS="24"
export DRY_RUN="true"

python attribute-and-term-counts-drift/python/recount_terms.py
node   attribute-and-term-counts-drift/node/recount-terms.js
```

`decide` is a pure function: a term is only repaired when its stored count disagrees with the freshly computed real count, and a negative real count is never written. It only ever writes a `count` number, never product data, price, or stock. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest attribute-and-term-counts-drift/python
node --test attribute-and-term-counts-drift/node
```
