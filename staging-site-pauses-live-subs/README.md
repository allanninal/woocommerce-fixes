# Staging site pauses live subs

A staging copy of a WooCommerce store can end up pointed at the live WooCommerce REST API and the live Stripe account, usually because the site URL was swapped during a migration but a saved API key or webhook target was not. When staging's own cron runs subscription renewals, a mismatched key or a stale test card makes the "payment" fail on staging, and WooCommerce Subscriptions pauses the real, live subscription. The customer was never actually charged for anything on staging, but their live subscription is now On-Hold and billing has stopped. This job finds subscriptions paused by a host that is not the live site, confirms with Stripe that the latest invoice for that subscription is genuinely paid, and restores only those to Active.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/staging-site-pauses-live-subs/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LIVE_SITE_HOST="yourstore.com"
export DRY_RUN="true"   # start safe, change to false to write

python staging-site-pauses-live-subs/python/restore_wrongly_paused_subs.py
node   staging-site-pauses-live-subs/node/restore-wrongly-paused-subs.js
```

`decide` is a pure function: a subscription is only restored when it is On-Hold, a non-live host is recorded as the one that paused it, and Stripe confirms the latest invoice is paid. Anything paused by the live site, or with no Stripe confirmation, is left alone or held for manual review. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest staging-site-pauses-live-subs/python
node --test "staging-site-pauses-live-subs/node/*.test.js"
```
