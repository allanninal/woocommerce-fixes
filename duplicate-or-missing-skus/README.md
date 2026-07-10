# Duplicate or missing SKUs

A CSV import, a plugin sync, or two editors saving at once can leave two products sharing one SKU, or a product with a blank SKU. WooCommerce does not stop this at the database level, so the store ends up with broken inventory sync, wrong analytics, and orders that point at the wrong item. This job walks every product and variation, groups them by SKU, and reports every group that is duplicated or blank. It never renames a SKU on its own. A product tied to a real paid order (confirmed against Stripe using the PaymentIntent id saved on the order) is only flagged for a human to review, since renaming a SKU under a paid order can break fulfillment and reporting. A product with no paid order behind it is flagged as safe to auto-fix.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/duplicate-or-missing-skus/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export ORDER_LOOKBACK_DAYS="90"
export DRY_RUN="true"

python duplicate-or-missing-skus/python/sku_audit.py
node   duplicate-or-missing-skus/node/sku-audit.js
```

`decide` is a pure function: a SKU group is only reported when it is duplicated or blank. It is marked `review` when a paid order (confirmed succeeded in Stripe) depends on one of the items, and `auto_fixable` when none do. It is read only by default. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest duplicate-or-missing-skus/python
node --test duplicate-or-missing-skus/node
```
