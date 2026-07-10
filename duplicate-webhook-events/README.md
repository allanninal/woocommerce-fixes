# Duplicate webhook events

Stripe retries a webhook delivery whenever it does not get a fast 2xx response, and the same event id can also be redelivered after a dashboard resend or a queue replay. If the handler is not idempotent, the same `event.id` applies its order note, stock change, or email a second time. This job keeps a small ledger of event ids already applied to each order, stored in the order's own meta data, and skips any event id it has already seen before doing any work.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/duplicate-webhook-events/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_HOURS="24"
export DRY_RUN="true"

python duplicate-webhook-events/python/dedupe_webhook_events.py
node   duplicate-webhook-events/node/dedupe-webhook-events.js
```

`decide` is a pure function: an event is only applied when its type is one this handler acts on, the order exists, and its id is not already in that order's ledger. It is safe to run again and again, since every already-seen event id is skipped. Start with `DRY_RUN=true` to review the plan before it writes.

## Test

```bash
pytest duplicate-webhook-events/python
node --test duplicate-webhook-events/node
```
