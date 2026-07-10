# Detect test vs live key mixups

A test key on a live store rejects every charge, and a live key on a staging store is worse. This job reads the WooCommerce Stripe gateway's declared mode (test or live), compares it to the mode of the Stripe secret key it was given, and then confirms the finding against a real recent order's PaymentIntent. Stripe's own error message on a cross-mode lookup, "a similar object exists in live mode, but a test mode key was used to make this request", is the strongest signal there is, so the script uses it directly instead of guessing. It never rotates or writes a key. It only reports what it finds as an order note and a log line.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/detect-test-vs-live-key-mixups/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_ORDERS="20"
export DRY_RUN="true"

python detect-test-vs-live-key-mixups/python/detect_key_mixup.py
node   detect-test-vs-live-key-mixups/node/detect-key-mixup.js
```

`decide` is a pure function: it takes the configured key's mode, the store's declared mode, and (optionally) a Stripe error message from a live probe, and returns one of `match`, `config_drift`, `confirmed_mismatch`, or `inconclusive`. It is read only by default (it just adds a note). Start with `DRY_RUN=true` to review the finding first.

## Test

```bash
pytest detect-test-vs-live-key-mixups/python
node --test detect-test-vs-live-key-mixups/node
```
