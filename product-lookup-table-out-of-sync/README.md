# Product lookup table out of sync

WooCommerce keeps a fast lookup table, `wp_wc_product_meta_lookup`, as a cached copy of each product's price, stock, and a few other fields, used by storefront filters, sorting, and reports. That copy only refreshes when normal WooCommerce code saves the product, so a direct database edit, a raw SQL import, or a plugin that writes post meta straight into the database can change the real product without ever refreshing the lookup row. This job reads each product through the REST API, cross-checks its price and stock against what recent paid orders for that product actually charged (using the Stripe PaymentIntent amount as the source of truth), and resaves any product whose lookup data looks stale so WooCommerce rebuilds that row itself. It never writes to the lookup table directly.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/product-lookup-table-out-of-sync/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="14"
export MIN_MISMATCHED_ORDERS="2"
export DRY_RUN="true"   # true also is the default, so this line is optional

python product-lookup-table-out-of-sync/python/rebuild_lookup_rows.py
node   product-lookup-table-out-of-sync/node/rebuild-lookup-rows.js
```

`decide` is a pure function: a product is only marked for resave when at least `MIN_MISMATCHED_ORDERS` recent, non-discounted orders show a price that disagrees with the product's current price while agreeing with the confirmed Stripe amount, or when the lookup data claims the product is in stock with zero quantity. It never touches `wp_wc_product_meta_lookup` directly, it resaves the product through the WooCommerce REST API so WooCommerce's own save path rebuilds the row. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest product-lookup-table-out-of-sync/python
node --test product-lookup-table-out-of-sync/node
```
