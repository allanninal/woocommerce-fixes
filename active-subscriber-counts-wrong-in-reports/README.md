# Active subscriber counts wrong in reports

WooCommerce Subscriptions reports read a stored total (a transient, a report table row, or an option updated by a scheduled action) instead of counting live subscriptions. When that cache misses a status change, an expired trial, or a failed renewal that should have ended a subscription, the "Active subscribers" number on the dashboard drifts from reality. This job recounts real subscriptions from the WooCommerce REST API with a pure decision function, cross-checks a sample against Stripe, and reports (or repairs) the cached total.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/active-subscriber-counts-wrong-in-reports/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export STRIPE_SAMPLE_SIZE="20"   # how many subscriptions to spot check against Stripe
export DRY_RUN="true"

python active-subscriber-counts-wrong-in-reports/python/recount_active_subscribers.py
node   active-subscriber-counts-wrong-in-reports/node/recount-active-subscribers.js
```

`isRealSubscriber` / `is_real_subscriber` and `decide` are pure functions. A subscription counts only when WooCommerce Subscriptions would treat it as `active` or `pending-cancel`, is not an unconverted trial, and has not passed its end date. A drift of two or fewer is auto repairable; anything larger is reported but left alone until you review it. Start with `DRY_RUN=true` to see the corrected count before it writes anything.

## Test

```bash
pytest active-subscriber-counts-wrong-in-reports/python
node --test active-subscriber-counts-wrong-in-reports/node
```
