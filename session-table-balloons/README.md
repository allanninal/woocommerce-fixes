# Session table balloons

WooCommerce is supposed to prune expired rows from `wp_woocommerce_sessions` on its own, every time a scheduled cleanup event runs. When that event stops firing (WP-Cron disabled, Action Scheduler stuck, a host that kills long requests), expired rows never get removed and the table grows without bound, sometimes into gigabytes of almost entirely expired data. This job reads the table's real size from the WooCommerce REST API's system status report, and if it is over a threshold, checks Stripe for any PaymentIntent tied to a recent order that still looks like a checkout in progress before it runs WooCommerce's own `clear_sessions` maintenance tool. Safe by default. Run on a schedule.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/session-table-balloons/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export MAX_SESSIONS_MB="50"
export CHECKOUT_GUARD_MINUTES="15"
export DRY_RUN="true"

python session-table-balloons/python/clear_stale_sessions.py
node   session-table-balloons/node/clear-stale-sessions.js
```

`decide` is a pure function: the table is only cleared once it is at or over `MAX_SESSIONS_MB` and no recent order still has an open Stripe PaymentIntent (a shopper who may be mid-checkout right now). Start with `DRY_RUN=true` to review the size and the checkout guard before it writes.

## Test

```bash
pytest session-table-balloons/python
node --test session-table-balloons/node
```
