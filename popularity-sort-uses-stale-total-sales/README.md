# Popularity sort uses stale total_sales

WooCommerce's "Popularity" catalog sort orders products by the `total_sales` number stored on each product, and that number only moves through WooCommerce's own order status hooks. Imported orders, a status changed by another plugin or a direct database update, and refunds or cancellations that never decrement the count all leave `total_sales` wrong, so the storefront ranks products by a number that no longer matches real sales. This job walks paid orders in a lookback window, sums real quantities per product from the orders and refunds, and corrects any product whose stored `total_sales` disagrees with reality.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/popularity-sort-uses-stale-total-sales/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="365"
export DRY_RUN="true"

python popularity-sort-uses-stale-total-sales/python/recount_total_sales.py
node   popularity-sort-uses-stale-total-sales/node/recount-total-sales.js
```

`decide` is a pure function: a product is only corrected when the stored `total_sales` disagrees with the quantity actually sold, computed from paid order line items minus refunded quantities. Start with `DRY_RUN=true` to review the list of products it would correct before it writes.

## Test

```bash
pytest popularity-sort-uses-stale-total-sales/python
node --test popularity-sort-uses-stale-total-sales/node
```
