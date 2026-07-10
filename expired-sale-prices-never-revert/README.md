# Expired sale prices never revert

A scheduled sale finishes on paper, but the `wc_scheduled_sales` WP-Cron task that should clear it never runs (WP-Cron disabled, no overnight traffic, a migration, a plugin conflict). This job walks every product WooCommerce currently flags as on sale, compares its stored sale end date to the current time, and clears the sale price (and sale dates) for any product whose sale window has already passed. The regular price is never touched.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/expired-sale-prices-never-revert/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python expired-sale-prices-never-revert/python/revert_expired_sales.py
node   expired-sale-prices-never-revert/node/revert-expired-sales.js
```

`decide` is a pure function: a product is reverted only when it has a sale price set and its sale end date has already passed. Products with no sale price, no end date, or a future end date are left alone. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest expired-sale-prices-never-revert/python
node --test expired-sale-prices-never-revert/node
```
