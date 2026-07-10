# Bulk pause on both systems

Pausing a batch of WooCommerce Subscriptions with the bulk "Change status to on-hold" action only updates the store side, the subscription status and its scheduled renewal actions. It does not call Stripe. When billing runs through a Stripe Subscription object, Stripe keeps invoicing on its own schedule until something explicitly pauses it. This script takes a list of subscription IDs, reads the matching Stripe subscription for each one, and pauses both sides together: WooCommerce to on-hold and Stripe with `pause_collection` set to `void`, skipping anything already paused, cancelled, or missing a Stripe subscription id.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/bulk-pause-on-both-systems/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export SUBSCRIPTION_IDS="1201,1202,1203"
export DRY_RUN="true"

python bulk-pause-on-both-systems/python/bulk_pause.py
node   bulk-pause-on-both-systems/node/bulk-pause.js
```

`decide` is a pure function: a subscription is paused only when it is active in WooCommerce and its Stripe subscription is also active and not already paused. It is safe by default, always start with `DRY_RUN=true` to review the exact list before anything writes.

## Test

```bash
pytest bulk-pause-on-both-systems/python
node --test bulk-pause-on-both-systems/node
```
