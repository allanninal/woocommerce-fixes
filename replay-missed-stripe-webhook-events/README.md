# Replay missed Stripe webhook events

Your store was down past Stripe's retry window, so webhook events stopped arriving and orders drifted out of sync. This reconciler lists events with `delivery_success` false over the downtime window and reapplies the ones it understands (complete an order for a succeeded payment, record a refund), tracking event IDs so nothing runs twice. Every action is idempotent, so it is safe to run again or on a schedule.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/replay-missed-stripe-webhook-events/

## Run it

```bash
export DRY_RUN="true"
export LOOKBACK_HOURS="120"   # cover the outage window plus a margin

python replay-missed-stripe-webhook-events/python/replay_events.py
node   replay-missed-stripe-webhook-events/node/replay-events.js
```

## Test

```bash
pytest replay-missed-stripe-webhook-events/python
node --test replay-missed-stripe-webhook-events/node
```
