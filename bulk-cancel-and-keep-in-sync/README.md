# Bulk cancel and keep in sync

Cancelling a batch of WooCommerce subscriptions from the admin's bulk action does not reliably cancel the matching Stripe subscription for every row, especially in a large batch where a request times out or a subscription lost its saved Stripe id along the way. This script takes a list of WooCommerce subscription IDs, reads the linked Stripe subscription id from meta, checks the live status on both systems, and cancels only the side that is not already cancelled, leaving anything already in sync untouched and reporting anything it cannot match as an orphan for manual review.

**Full guide:** https://www.allanninal.dev/woocommerce/bulk-cancel-and-keep-in-sync/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export SUBSCRIPTION_IDS="4821,4822,4830,4901"
export DRY_RUN="true"   # start safe, change to false to write

python bulk-cancel-and-keep-in-sync/python/bulk_cancel_sync.py
node   bulk-cancel-and-keep-in-sync/node/bulk-cancel-sync.js
```

`decide` is a pure function: it takes the WooCommerce subscription and the Stripe subscription and returns one of `skip`, `cancel_both`, `cancel_stripe_only`, `cancel_woo_only`, or `orphan`, with no network calls of its own. Start with `DRY_RUN=true` to review the full plan, including every orphan, before anything is cancelled for real.

## Test

```bash
pytest bulk-cancel-and-keep-in-sync/python
node --test bulk-cancel-and-keep-in-sync/node
```
