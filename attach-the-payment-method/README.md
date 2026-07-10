# Attach the payment method

A Stripe PaymentMethod can exist and even look saved in WooCommerce, but it is only chargeable off session once it is attached to a Stripe Customer object. This job walks recent orders, resolves the saved PaymentMethod id (from order meta `_stripe_intent_id` or a `pm_` prefixed `transaction_id`), checks whether Stripe shows it attached to the expected Customer, and attaches it when it is loose. A PaymentMethod attached to a different customer is flagged for a human, never auto moved.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/attach-the-payment-method/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export DRY_RUN="true"

python attach-the-payment-method/python/attach_payment_method.py
node   attach-the-payment-method/node/attach-payment-method.js
```

`decide` is a pure function: it only recommends attaching a PaymentMethod that is unattached, skips anything it cannot check, and flags (never auto resolves) a PaymentMethod already attached to a different customer. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest attach-the-payment-method/python
node --test attach-the-payment-method/node
```
