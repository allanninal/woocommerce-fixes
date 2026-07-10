# Renewal marked paid with no payment

A caching bug or a race between two renewal attempts can let the WooCommerce Subscriptions renewal handler take its success path, marking the renewal order paid and extending the subscription, without a succeeded Stripe PaymentIntent ever existing behind it. This job walks recent renewal orders, looks up the saved PaymentIntent, and flags any renewal whose payment is missing, not succeeded, or the wrong amount, by adding an order note (and optionally moving it to on-hold for review).

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/renewal-marked-paid-with-no-payment/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export REVIEW_HOLD="false"   # true also moves flagged renewals to on-hold
export DRY_RUN="true"

python renewal-marked-paid-with-no-payment/python/flag_fake_paid_renewals.py
node   renewal-marked-paid-with-no-payment/node/flag-fake-paid-renewals.js
```

`decide` is a pure function: a renewal is flagged only when it is in a paid state while Stripe has no matching succeeded charge of the right amount. It is read only by default (it just adds a note). Start with `DRY_RUN=true` to review the list first, and only turn on `REVIEW_HOLD` once you trust the report.

## Test

```bash
pytest renewal-marked-paid-with-no-payment/python
node --test renewal-marked-paid-with-no-payment/node
```
