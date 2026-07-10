# Stuck in pending-cancel

A WooCommerce subscription moves to pending-cancel when a customer cancels but the
current paid period has not finished yet. It is supposed to flip to cancelled on its
own once the end date arrives, through a scheduled Action Scheduler action. When that
scheduled action never runs, the subscription sits in pending-cancel forever. This job
walks subscriptions in pending-cancel, and for any whose end date has passed, checks
with Stripe that it is not still actively billing, then moves it to cancelled through
the WooCommerce REST API. Read only until you turn off dry run.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/stuck-in-pending-cancel/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export GRACE_HOURS="2"
export DRY_RUN="true"

python stuck-in-pending-cancel/python/cancel_stuck_pending_cancel.py
node   stuck-in-pending-cancel/node/cancel-stuck-pending-cancel.js
```

`decide` is a pure function: a subscription is only moved to cancelled when its status
is pending-cancel, its end date has passed, and Stripe does not show it still active,
trialing, or past_due. Anything else is left untouched. Start with `DRY_RUN=true` to
review the list first.

## Test

```bash
pytest stuck-in-pending-cancel/python
node --test stuck-in-pending-cancel/node
```
