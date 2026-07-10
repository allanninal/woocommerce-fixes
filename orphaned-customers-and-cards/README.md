# Orphaned customers and cards

A WooCommerce user stores its Stripe customer id in user meta `_stripe_customer_id`. A deleted WordPress user, a database import, or a customer merge can leave that link pointing at nothing, or pointing at a Stripe customer that now belongs to someone else. Meanwhile Stripe can be holding a customer object, and a saved card, that no WooCommerce user ever claims. This job walks both sides, decides what is wrong with a pure function, and either reports it (dry run) or repairs it: reconnect a link that just moved, or delete a Stripe customer that is genuinely abandoned and has no subscriptions or saved payment methods worth keeping.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/orphaned-customers-and-cards/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="90"
export DELETE_ABANDONED="false"   # true also deletes truly orphaned Stripe customers
export DRY_RUN="true"

python orphaned-customers-and-cards/python/find_orphaned_customers.py
node   orphaned-customers-and-cards/node/find-orphaned-customers.js
```

`decide` is a pure function: a Stripe customer is only reconnected or deleted when the facts are unambiguous, and it is never deleted while it still has an active subscription or a saved payment method. Start with `DRY_RUN=true` to review the list first, and keep `DELETE_ABANDONED=false` until you trust the report.

## Test

```bash
pytest orphaned-customers-and-cards/python
node --test orphaned-customers-and-cards/node
```
