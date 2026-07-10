# Stripe bills after cancellation

Cancelling a WooCommerce Subscription only updates the order and the local subscription post. It does not, by itself, guarantee the linked Stripe Subscription object gets canceled too. If that second cancel call is skipped, delayed, or lost, Stripe's billing cycle keeps running and the customer's card is charged again on the next renewal date even though WooCommerce shows the subscription as cancelled. This job walks recently cancelled WooCommerce subscriptions, reads the saved Stripe subscription id, and cancels the Stripe side for any subscription Stripe still shows as active, trialing, or past_due.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/stripe-bills-after-cancellation/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"

python stripe-bills-after-cancellation/python/cancel_stripe_subscription.py
node   stripe-bills-after-cancellation/node/cancel-stripe-subscription.js
```

`decide` is a pure function: a subscription is only canceled in Stripe when WooCommerce already shows it as cancelled, pending-cancel, or expired, and Stripe still shows it as active, trialing, past_due, or unpaid. It never touches a subscription that WooCommerce still considers live. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest stripe-bills-after-cancellation/python
node --test stripe-bills-after-cancellation/node
```
