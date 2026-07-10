# HPOS schedule divergence

On a store with High Performance Order Storage (HPOS) turned on, WooCommerce Subscriptions still keeps a legacy postmeta copy of each schedule date so older code that reads postmeta directly does not break. When something writes to one copy and not the other, the next payment date shown by the REST API (HPOS) and the date in postmeta disagree, and whichever code path reads the stale copy renews at the wrong time. This job reads each active subscription from HPOS, compares it with the postmeta copy and with the last real Stripe charge on the linked renewal order, repairs postmeta when it has drifted from HPOS, and flags anything that still looks wrong for manual review. Read only by default. Run on a schedule.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/hpos-schedule-divergence/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export DRIFT_TOLERANCE_SECONDS="3600"
export DRY_RUN="true"

python hpos-schedule-divergence/python/reconcile_schedule_dates.py
node   hpos-schedule-divergence/node/reconcile-schedule-dates.js
```

`decide` is a pure function: a subscription is only repaired when the HPOS schedule date and the postmeta copy disagree with each other by more than the drift tolerance, and only flagged when both copies agree but the schedule date is not after the last succeeded Stripe charge on the subscription's most recent order. It reads the Stripe PaymentIntent id from order meta `_stripe_intent_id`, falling back to `transaction_id`. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest hpos-schedule-divergence/python
node --test hpos-schedule-divergence/node
```
