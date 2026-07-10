# On sale flag shows products not on sale

A product keeps its on sale badge and strikethrough price after the sale should be over, because that state is a cached flag rather than a live check of the prices. The cache falls behind when the daily `wc_scheduled_sales` cron is missed, or when prices are changed outside WooCommerce's normal save path (a direct database edit or a bulk import). This job walks the catalog, recomputes whether each product should currently be on sale from its own regular price, sale price, and sale date range, and corrects the ones whose stored flag disagrees.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/on-sale-flag-shows-products-not-on-sale/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # start safe, change to false to write

python on-sale-flag-shows-products-not-on-sale/python/recompute_on_sale.py
node   on-sale-flag-shows-products-not-on-sale/node/recompute-on-sale.js
```

`decide` (and the `shouldBeOnSale` helper it relies on) is a pure function: a product is only fixed when its stored `on_sale` flag disagrees with what its regular price, sale price, and sale date range actually say. It never invents a new price, it only clears a stale sale price or nudges WooCommerce to recompute one that is still valid. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest on-sale-flag-shows-products-not-on-sale/python
node --test on-sale-flag-shows-products-not-on-sale/node
```
