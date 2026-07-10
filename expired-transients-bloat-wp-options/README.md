# Expired transients bloat wp_options

The WooCommerce Stripe gateway writes a short lived transient as a checkout lock every time a shopper starts paying, so the same PaymentIntent cannot be processed twice at once. When checkout is interrupted (a fatal error, a webhook timeout, a closed tab) that lock is never cleared and never asked for again, so it sits in `wp_options`, almost always with `autoload=yes`, forever. This script cannot run raw SQL, so instead it walks recent orders through the WooCommerce REST API, checks each saved PaymentIntent on Stripe, and clears the order's own lock flag once Stripe confirms the intent is fully settled (succeeded or canceled), logging the matching transient key so a site cleanup job or WP-CLI can sweep it out of `wp_options` in bulk.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/expired-transients-bloat-wp-options/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export DRY_RUN="true"

python expired-transients-bloat-wp-options/python/clear_stale_checkout_locks.py
node   expired-transients-bloat-wp-options/node/clear-stale-checkout-locks.js
```

`decide` is a pure function: an order's checkout lock is only cleared when it is still set and Stripe confirms the matching PaymentIntent is `succeeded` or `canceled`. It is safe to run again and again, since an order with no lock or an intent still in progress is always skipped. Start with `DRY_RUN=true` to review the list before it writes.

## Test

```bash
pytest expired-transients-bloat-wp-options/python
node --test expired-transients-bloat-wp-options/node
```
