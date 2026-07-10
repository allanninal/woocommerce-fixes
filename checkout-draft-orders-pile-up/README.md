# Checkout-draft orders pile up

The block based checkout creates a WooCommerce order in the `checkout-draft` status the moment a shopper opens the checkout page, before they type an address or pay a cent. Most shoppers who bounce never come back, so that draft sits in the database forever. Nothing in WooCommerce core ever removes it. This job walks old `checkout-draft` orders, checks Stripe to make sure no real payment is attached, cancels any PaymentIntent still left open, and trashes the drafts that are safe to remove. Read only by default. Run on a schedule.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/checkout-draft-orders-pile-up/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export STALE_AFTER_HOURS="24"
export DRY_RUN="true"

python checkout-draft-orders-pile-up/python/purge_checkout_drafts.py
node   checkout-draft-orders-pile-up/node/purge-checkout-drafts.js
```

`decide` is a pure function: a draft is only purged once it is older than `STALE_AFTER_HOURS` and Stripe has no succeeded or processing PaymentIntent attached to it. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest checkout-draft-orders-pile-up/python
node --test checkout-draft-orders-pile-up/node
```
