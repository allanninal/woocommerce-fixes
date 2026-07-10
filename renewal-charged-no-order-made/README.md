# Renewal charged, no order made

Stripe shows a subscription renewal that went through, the invoice is paid, and the subscription's next billing date has already moved forward. But WooCommerce has no renewal order for that charge. This job walks recent succeeded renewal charges from Stripe, checks whether the subscription already has a matching renewal order, and creates the missing order when it does not, the same way WooCommerce Subscriptions would have.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/renewal-charged-no-order-made/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_HOURS="48"
export DRY_RUN="true"   # start safe, change to false to write

python renewal-charged-no-order-made/python/create_missing_renewal.py
node   renewal-charged-no-order-made/node/create-missing-renewal.js
```

`decide` is a pure function: a renewal order is created only when a PaymentIntent is confirmed succeeded on Stripe, points to a real subscription, and has no matching renewal order already on file. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest renewal-charged-no-order-made/python
node --test renewal-charged-no-order-made/node
```
