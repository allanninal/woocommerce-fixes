# Stripe Link becomes manual

A subscription paid at checkout with Stripe Link can complete its first payment fine and still leave WooCommerce Subscriptions without a reusable payment method to bill next cycle. WooCommerce Subscriptions plays it safe and flips the subscription to manual renewal, so it emails an invoice instead of charging automatically, and most customers never pay it by hand. This job checks each manual subscription's Stripe customer for a genuinely reusable payment method (card, US bank account, or SEPA debit) and switches the subscription back to automatic only when one is actually there.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/stripe-link-becomes-manual/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # start safe, change to false to write

python stripe-link-becomes-manual/python/restore_automatic_renewal.py
node   stripe-link-becomes-manual/node/restore-automatic-renewal.js
```

`decide` is a pure function: a subscription is only repaired when it is on manual renewal, billed through the Stripe gateway, and Stripe now shows a reusable payment method for that customer. Subscriptions with nothing reusable on file are left on manual renewal, on purpose. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest stripe-link-becomes-manual/python
node --test stripe-link-becomes-manual/node
```
