# Late failure reverts a paid order

Sometimes a `charge.failed` or `payment_intent.payment_failed` event for an earlier attempt arrives after the payment actually succeeded, and the WooCommerce Stripe gateway flips a good order to failed or cancelled. Stripe is the source of truth: if it shows the PaymentIntent as `succeeded` with a matching amount, the order should be paid. This job finds the reverted orders and moves them back to Processing.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/late-failure-reverts-paid-order/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_HOURS="72"
export DRY_RUN="true"

python late-failure-reverts-paid-order/python/restore_paid.py
node   late-failure-reverts-paid-order/node/restore-paid.js
```

`decide` is a pure function, so it only restores an order that is currently failed or cancelled while Stripe shows a succeeded PaymentIntent of the matching amount. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest late-failure-reverts-paid-order/python
node --test late-failure-reverts-paid-order/node
```
