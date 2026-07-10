# Double stock reduction

Stock can drop by more than an order actually sold when WooCommerce's stock reduction routine runs twice for the same order, usually from a duplicate payment webhook or a manual admin action that bypasses the `_order_stock_reduced` guard. This job walks recent orders, compares each order's real line item quantities against the recorded reduction, and adds back any extra units it finds, leaving the first legitimate reduction untouched.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/double-stock-reduction/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="14"
export DRY_RUN="true"   # start safe, change to false to write

python double-stock-reduction/python/repair_double_stock.py
node   double-stock-reduction/node/repair-double-stock.js
```

`decide` is a pure function: an order is only flagged as a double reduction when its recorded reduced quantity is a whole multiple of its real line item quantity and that multiple is two or more. Anything that looks off but is not a clean multiple is left for a human to review. It is read only by default. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest double-stock-reduction/python
node --test double-stock-reduction/node
```
