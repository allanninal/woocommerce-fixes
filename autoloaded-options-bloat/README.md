# Autoloaded options bloat

WordPress loads every option marked `autoload='yes'` into memory on every single page
load, including the storefront and every REST API call. WooCommerce Stripe gateways
write small per-order records (an idempotency lock, a processing flag, a cached
PaymentIntent snapshot) while a payment is in flight, and some of these keep
`autoload` at the default of "yes". Once the order is finished they serve no
purpose, but nothing ever cleans them up, so the autoloaded payload only grows and
every page gets a little slower. This job reads a list of oversized autoloaded
options, matches the Stripe-related ones back to their order and Stripe
PaymentIntent, and demotes the ones that are safe to demote to `autoload='no'`.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/autoloaded-options-bloat/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export MIN_BYTES="10000"
export DRY_RUN="true"

python autoloaded-options-bloat/python/find_stale_autoload.py
node   autoloaded-options-bloat/node/find-stale-autoload.js
```

`decide` is a pure function: an option is only demoted once it matches the
`_wc_stripe_*_{order_id}` naming pattern, is above the size threshold, and both the
order and its Stripe PaymentIntent have reached a finished state. It is read only
by default. Start with `DRY_RUN=true` to review the list before it writes.

## Test

```bash
pytest autoloaded-options-bloat/python
node --test autoloaded-options-bloat/node
```
