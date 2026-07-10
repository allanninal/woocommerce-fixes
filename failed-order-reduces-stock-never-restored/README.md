# Failed order reduces stock, never restored

WooCommerce reduces stock the moment an order is placed, before payment is confirmed. When that order later moves to Failed or Cancelled, WooCommerce is supposed to add the stock back automatically. That restore step can be skipped: a Stripe decline that lands after a timeout, a status change made through the REST API or an import tool, a plugin that short circuits the transition, or a restart mid request. The order is left holding a `_order_stock_reduced` flag with no matching stock increase, and the product quietly sells out early. This job walks recent Failed and Cancelled orders, and for any order still flagged as having reduced stock, adds each line item's quantity back to the matching product or variation and clears the flag.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/failed-order-reduces-stock-never-restored/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"   # start safe, change to false to write

python failed-order-reduces-stock-never-restored/python/restore_failed_stock.py
node   failed-order-reduces-stock-never-restored/node/restore-failed-stock.js
```

`decide` is a pure function: an order is restored only when its status is Failed or Cancelled, the `_order_stock_reduced` meta flag is still "1", and it has at least one line item with stock to give back. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest failed-order-reduces-stock-never-restored/python
node --test failed-order-reduces-stock-never-restored/node
```
