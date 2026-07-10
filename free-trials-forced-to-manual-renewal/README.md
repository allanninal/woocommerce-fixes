# Free trials forced to manual renewal

A free trial checkout confirms a zero amount Stripe setup that is only supposed to save a reusable card for later, no money moves yet. If that confirmation is interrupted, the trial still completes but no payment method is ever saved, so when the trial ends WooCommerce Subscriptions correctly has nothing to charge and marks the subscription "requires manual renewal" instead of failing silently. This job walks subscriptions currently on manual renewal, checks whether Stripe now has a real, reusable, non-expired payment method for that customer, and switches eligible subscriptions back to automatic.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/free-trials-forced-to-manual-renewal/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python free-trials-forced-to-manual-renewal/python/restore_trial_billing.py
node   free-trials-forced-to-manual-renewal/node/restore-trial-billing.js
```

`decide` is a pure function: a subscription is only restored to automatic when it is currently flagged `requires_manual_renewal` and Stripe has a reusable, non-expired card for that customer. It never touches price or dates, and it never restores a subscription that still genuinely has no card on file. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest free-trials-forced-to-manual-renewal/python
node --test free-trials-forced-to-manual-renewal/node
```
