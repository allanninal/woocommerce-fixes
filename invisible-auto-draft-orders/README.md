# Invisible auto-draft orders

The block based checkout, and some older plugins, create a WooCommerce order the moment a buyer opens the checkout page, before they pay anything. That order sits with status `auto-draft` or `checkout-draft`. It never shows in the Orders list, so nobody notices it, but it stays in the database forever unless something cleans it up. On a busy store this quietly grows into thousands of rows. This job walks those hidden statuses, leaves anything tied to a Stripe PaymentIntent that is still in progress or already paid completely alone, and removes the rest once they pass a safety age.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/invisible-auto-draft-orders/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export MAX_AGE_HOURS="24"
export DRY_RUN="true"

python invisible-auto-draft-orders/python/purge_auto_drafts.py
node   invisible-auto-draft-orders/node/purge-auto-drafts.js
```

`decide` is a pure function: a draft order is only marked for deletion once it is older than `MAX_AGE_HOURS` and has no Stripe PaymentIntent that is still in progress or already succeeded. It never touches an order that is not an auto-draft. Start with `DRY_RUN=true` to review the list of orders it would remove before it deletes anything.

## Test

```bash
pytest invisible-auto-draft-orders/python
node --test invisible-auto-draft-orders/node
```
