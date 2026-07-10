# Clean up abandoned PaymentIntents

Every checkout page load can mint a Stripe PaymentIntent, and abandoned ones pile up as Incomplete payments with matching pending orders. This reconciler lists recent PaymentIntents, keeps the ones that are old, never attempted a payment, and have no charge or error, then cancels the intent and its pending order to release stock. Declines and late successes are left for their own reconcilers.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/cancel-abandoned-payment-intents/

## Run it

```bash
export DRY_RUN="true"
export THRESHOLD_HOURS="12"   # give shoppers time to come back before cancelling

python cancel-abandoned-payment-intents/python/cancel_abandoned.py
node   cancel-abandoned-payment-intents/node/cancel-abandoned.js
```

## Test

```bash
pytest cancel-abandoned-payment-intents/python
node --test cancel-abandoned-payment-intents/node
```
