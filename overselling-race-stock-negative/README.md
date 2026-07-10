# Overselling race drives stock negative

Under a burst of concurrent orders, two checkouts can both pass the stock check and each reduce stock, so a WooCommerce product or variation falls below zero. Negative stock skews reports and reorder math. This job walks managed-stock products and variations, finds the ones below zero, and sets them back to zero over the REST API (so it works with HPOS on).

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/overselling-race-stock-negative/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python overselling-race-stock-negative/python/fix_negative_stock.py
node   overselling-race-stock-negative/node/fix-negative-stock.js
```

`is_oversold` is a pure function: an item is oversold only when it manages stock and its quantity is below zero, so a product that does not track stock or is simply at zero is never touched. Start with `DRY_RUN=true` to review the list first, and only reset once the oversold orders are accounted for.

## Test

```bash
pytest overselling-race-stock-negative/python
node --test overselling-race-stock-negative/node
```
