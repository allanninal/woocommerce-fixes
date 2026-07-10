# Stale IDs after a gateway switch

When a store moves to a new Stripe account, a new Stripe mode (test to live), or a different payment gateway, old orders keep the previous PaymentIntent id in meta `_stripe_intent_id` or `transaction_id`. That id does not exist under the new secret key, so any later action that reads it, a refund, a renewal charge, a sync job, fails with a Stripe "No such payment_intent" error even though the order itself is fine. This job walks recent orders, tries to resolve each saved id against the current Stripe account, and clears the ones that do not resolve, only on orders whose payment already finished.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/stale-ids-after-a-gateway-switch/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="90"
export DRY_RUN="true"

python stale-ids-after-a-gateway-switch/python/clear_stale_intent_ids.py
node   stale-ids-after-a-gateway-switch/node/clear-stale-intent-ids.js
```

`decide` is a pure function: an order's saved id is only cleared when the order has already finished (Processing, Completed, Refunded, or On-hold) and Stripe cannot resolve the id in the current account. Start with `DRY_RUN=true` to review the list before it writes.

## Test

```bash
pytest stale-ids-after-a-gateway-switch/python
node --test stale-ids-after-a-gateway-switch/node
```
