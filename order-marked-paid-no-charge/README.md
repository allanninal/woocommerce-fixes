# Order marked paid with no charge

An order can end up Processing or Completed without a real payment behind it: a manual status change, a failed integration that skipped the charge, or a tampered checkout. This job walks recent paid orders, looks up the saved Stripe PaymentIntent, and flags any order whose payment is missing, not succeeded, or the wrong amount, by adding an order note (and optionally moving it to on-hold for review).

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/order-marked-paid-no-charge/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export REVIEW_HOLD="false"   # true also moves flagged orders to on-hold
export DRY_RUN="true"

python order-marked-paid-no-charge/python/verify_paid.py
node   order-marked-paid-no-charge/node/verify-paid.js
```

`decide` is a pure function: an order is flagged only when it is in a paid state while Stripe has no matching succeeded charge of the right amount. It is read only by default (it just adds a note). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest order-marked-paid-no-charge/python
node --test order-marked-paid-no-charge/node
```
