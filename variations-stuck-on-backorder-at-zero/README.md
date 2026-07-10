# Variations stuck On Backorder at zero

A product variation can end up showing "On backorder" in the shop while its stock is at or below zero and backorders are turned off for that variation. WooCommerce only recalculates `stock_status` when the quantity changes through its own save path, so a CSV import, a direct database edit, or flipping the backorders setting after the quantity was already low leaves the stored `stock_status` stale. This script walks the variations of a product (or every variable product), works out what `stock_status` should be from the quantity and the backorders setting, and corrects any variation that disagrees.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/variations-stuck-on-backorder-at-zero/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export PRODUCT_IDS=""   # blank scans every variable product, or a comma separated list of product ids
export DRY_RUN="true"   # start safe, change to false to write

python variations-stuck-on-backorder-at-zero/python/fix_variation_stock_status.py
node   variations-stuck-on-backorder-at-zero/node/fix-variation-stock-status.js
```

`decide` is a pure function: a variation is only flagged to fix when its stored `stock_status` disagrees with what the quantity and backorders setting say it should be. Variations that do not manage their own stock are left alone. Start with `DRY_RUN=true` to review the list before it writes.

## Test

```bash
pytest variations-stuck-on-backorder-at-zero/python
node --test variations-stuck-on-backorder-at-zero/node
```
