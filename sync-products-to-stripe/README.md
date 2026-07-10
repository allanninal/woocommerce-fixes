# Sync products to Stripe

A WooCommerce product, usually a WooCommerce Subscriptions plan, can be sold for months with no matching Stripe Product or Price behind it, often because it was imported, duplicated, or created before the store's Stripe gateway was fully wired up. This job walks published WooCommerce products, checks the Stripe Product and Price ids saved in product meta, creates whatever Stripe is missing (or re-creates a price after a WooCommerce price change), and writes the new ids back onto the product. Read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/sync-products-to-stripe/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DEFAULT_CURRENCY="usd"
export DRY_RUN="true"   # start safe, change to false to write

python sync-products-to-stripe/python/sync_products_to_stripe.py
node   sync-products-to-stripe/node/sync-products-to-stripe.js
```

`decide` is a pure function: a product is synced only when it is published, priced, and billed through Stripe, and the saved Stripe Product or Price is missing, archived, or out of date with the current WooCommerce price. Start with `DRY_RUN=true` to review the list before it writes.

## Test

```bash
pytest sync-products-to-stripe/python
node --test sync-products-to-stripe/node
```
