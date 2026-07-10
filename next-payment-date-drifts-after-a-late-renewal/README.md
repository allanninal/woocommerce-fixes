# Next payment date drifts after a late renewal

When a WooCommerce Subscriptions renewal runs late, from a failed payment retry, a delayed Action Scheduler run, or a manual retry from wp-admin, the next payment date can get recalculated from the moment that late renewal completed instead of from the subscription's original billing schedule. Each late renewal after that nudges the schedule a little further off. This job walks active subscriptions, recomputes the correct next payment date from the billing interval and period anchored to the start date, and corrects the stored date whenever it disagrees by more than a small tolerance, adding a subscription note either way.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/next-payment-date-drifts-after-a-late-renewal/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRIFT_TOLERANCE_HOURS="6"
export DRY_RUN="true"

python next-payment-date-drifts-after-a-late-renewal/python/fix_next_payment_drift.py
node   next-payment-date-drifts-after-a-late-renewal/node/fix-next-payment-drift.js
```

`correct_next_payment` and `decide` are pure functions: the schedule is recomputed by stepping forward in whole billing intervals from the subscription's start date, and a subscription is only flagged to fix when its stored next payment date disagrees with that computed schedule by more than `DRIFT_TOLERANCE_HOURS`. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest next-payment-date-drifts-after-a-late-renewal/python
node --test next-payment-date-drifts-after-a-late-renewal/node
```
