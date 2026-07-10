# Trial end action false-positive failure

WooCommerce Subscriptions runs a scheduled `woocommerce_scheduled_subscription_trial_end` action on the trial end date. When a slow request, a second worker, or a timeout makes that hook run twice, the loser of the race throws and Action Scheduler marks the action failed, even though the subscription already has the correct status and the first renewal order already exists. This job checks the subscription status and its renewal order (and, when one exists, its Stripe PaymentIntent) against the real state, and clears the alarm with a note when the failure turns out to be a false positive. It never re-runs the trial-end transition itself, since that duplicate run is what caused the problem in the first place.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/trial-end-action-false-positive-failure/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"

python trial-end-action-false-positive-failure/python/clear_trial_end_false_positive.py
node   trial-end-action-false-positive-failure/node/clear-trial-end-false-positive.js
```

`decide` is a pure function: it only clears the alarm when the subscription has moved past the trial and the renewal charge, if any, is confirmed succeeded on Stripe with a matching amount. Anything it cannot confirm comes back as `unclear` so a human can look, and anything that looks like a real failure comes back as `leave`. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest trial-end-action-false-positive-failure/python
node --test trial-end-action-false-positive-failure/node
```
