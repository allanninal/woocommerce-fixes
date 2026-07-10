# Order edits do not adjust stock

WooCommerce reduces stock once, when an order first moves to a stock reducing status, and stamps how much it took on each line item in `_reduced_stock` meta. If a shop manager later edits that order in the admin, changes a quantity, removes a line, or adds a new product, WooCommerce never revisits the stock it already reduced. This job walks recent orders, compares each line item's current quantity against its `_reduced_stock` meta, and restocks or further reduces the difference so product stock matches what the order actually charged for.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/order-edits-do-not-adjust-stock/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"   # start safe, change to false to write

python order-edits-do-not-adjust-stock/python/reconcile_stock.py
node   order-edits-do-not-adjust-stock/node/reconcile-stock.js
```

`decide` and `lineItemsNeedingSync` / `line_items_needing_sync` are pure functions: a line item is only adjusted when its order is in a stock reducing status, its product still exists and manages stock, and its current quantity no longer matches the quantity WooCommerce already reduced. Start with `DRY_RUN=true` to review the plan first.

## Test

```bash
pytest order-edits-do-not-adjust-stock/python
node --test order-edits-do-not-adjust-stock/node
```
