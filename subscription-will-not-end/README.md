# Subscription will not end

A WooCommerce Subscription with a fixed length ("bill for 12 months, then stop") is supposed to move to Expired on its own once its `end_date` passes, driven by an Action Scheduler hook. When that hook is deleted, never queued, or misses its run while the site is down, the subscription just keeps sitting on Active (or On hold) with an end date in the past, and it can keep renewing past the date the customer agreed to. This job walks open subscriptions, checks whether the end date has passed, and moves any overdue one to Expired through the REST API, the same way the scheduled hook would have, with a short grace window and a best-effort cleanup of any stale Stripe PaymentIntent left behind.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/subscription-will-not-end/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export GRACE_HOURS="6"
export DRY_RUN="true"

python subscription-will-not-end/python/expire_overdue_subscriptions.py
node   subscription-will-not-end/node/expire-overdue-subscriptions.js
```

`decide` is a pure function: a subscription is only marked to expire when it is still Active, On hold, or Pending cancellation, it has a real `end_date`, and that date is further in the past than `GRACE_HOURS`. Start with `DRY_RUN=true` to review the list before it writes anything.

## Test

```bash
pytest subscription-will-not-end/python
node --test subscription-will-not-end/node
```
