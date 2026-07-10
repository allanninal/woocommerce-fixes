# Remove test IDs from live

A test mode Stripe PaymentIntent id and a live mode id look identical, both start with `pi_`, so a leftover test id on a live WooCommerce order is invisible until something tries to use it and Stripe replies that it does not exist. This happens most often after a migration, a staging push that forgot to swap Stripe keys, or a developer testing checkout live by mistake. This script walks recent paid-looking orders, asks the live Stripe account to retrieve the saved id, and clears any id that comes back missing, leaving an order note behind (and optionally moving the order to on-hold for review).

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/remove-test-ids-from-live/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export REVIEW_HOLD="false"   # true also moves cleared orders to on-hold
export DRY_RUN="true"

python remove-test-ids-from-live/python/remove_test_ids.py
node   remove-test-ids-from-live/node/remove-test-ids.js
```

`decide` is a pure function: an order's Stripe id is only cleared when the order is in a paid-looking state and the live Stripe account cannot find that id at all. It never guesses a replacement. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest remove-test-ids-from-live/python
node --test remove-test-ids-from-live/node
```
