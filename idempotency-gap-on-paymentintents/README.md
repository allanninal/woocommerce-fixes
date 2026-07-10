# Idempotency gap on PaymentIntents

A retry that goes out without a Stripe Idempotency-Key, a flaky network, a page refresh, a double-click on "Place order", can create two separate PaymentIntents for the same checkout, and both can succeed. WooCommerce only stores one PaymentIntent id on the order, so the second charge is invisible unless you go looking for it in Stripe. This job walks recent paid orders, looks up the saved PaymentIntent, and searches the same Stripe customer for any other succeeded PaymentIntent with a matching amount inside a short time window. Anything it finds is a likely duplicate charge, reported as an order note for a human to review and refund.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/idempotency-gap-on-paymentintents/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export MATCH_WINDOW_MINUTES="30"
export DRY_RUN="true"

python idempotency-gap-on-paymentintents/python/find_duplicate_intents.py
node   idempotency-gap-on-paymentintents/node/find-duplicate-intents.js
```

`findCandidateDuplicates` (Python: `find_candidate_duplicates`) is a pure function: given the order's primary PaymentIntent and every other succeeded PaymentIntent for the same Stripe customer, it returns only the ones that match the order amount and were created inside the match window. It is read only by default, it just adds a note listing the likely duplicates. It never issues a refund on its own. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest idempotency-gap-on-paymentintents/python
node --test idempotency-gap-on-paymentintents/node
```
