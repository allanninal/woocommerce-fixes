# Authorized charges never captured

Manual-capture WooCommerce orders sit on hold with an authorized-but-uncaptured Stripe PaymentIntent. Stripe holds an authorization for about 7 days, then releases it and the money is gone. This job lists authorized PaymentIntents (`requires_capture`) whose order is still on hold, confirms the amount matches, and captures them before the hold expires, then moves the order to Processing.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/authorized-charges-never-captured/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_HOURS="168"
export DRY_RUN="true"

python authorized-charges-never-captured/python/capture_authorized.py
node   authorized-charges-never-captured/node/capture-authorized.js
```

The decision is a pure function, so it never captures an order that is already processing, whose amount does not match, or whose intent is not awaiting capture. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest authorized-charges-never-captured/python
node --test authorized-charges-never-captured/node
```
