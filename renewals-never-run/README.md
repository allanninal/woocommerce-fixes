# Renewals never run

When the Action Scheduler queue stalls (a fatal error in one action, a maxed out worker, a cron that stopped firing) the `scheduled-subscription-payment` actions pile up "pending" long past their scheduled date. WooCommerce never asks Stripe for the money, so the subscription just sits there looking active while nothing is billed. This job walks active and on-hold subscriptions, works out which ones are actually due, and charges the saved Stripe payment method directly for any renewal the scheduler missed, skipping anything still inside a grace window or too stale to auto-charge.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/renewals-never-run/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export GRACE_HOURS="3"
export STALE_DAYS="14"
export DRY_RUN="true"

python renewals-never-run/python/run_due_renewals.py
node   renewals-never-run/node/run-due-renewals.js
```

`decide` is a pure function: a renewal is only charged once it is past due, past the grace window, has a saved payment method, and is not already overdue past the stale window. Anything overdue past `STALE_DAYS` is left for a human, not auto-charged. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest renewals-never-run/python
node --test renewals-never-run/node
```
