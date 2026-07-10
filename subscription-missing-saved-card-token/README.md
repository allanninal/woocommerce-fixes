# Subscription has no saved card, so renewals fail

A retry at checkout dropped the Stripe token, so the subscription has no saved customer or card and every renewal fails with "unable to process your payment." This reconciler finds active subscriptions with no `_stripe_customer_id`, recovers the customer and card from the paid parent order's PaymentIntent, and writes them back onto the subscription. Subscriptions with no reusable card are flagged for a customer update.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/subscription-missing-saved-card-token/

## Run it

```bash
export DRY_RUN="true"

python subscription-missing-saved-card-token/python/backfill_sub_token.py
node   subscription-missing-saved-card-token/node/backfill-sub-token.js
```

Needs the WooCommerce Subscriptions REST API (WooCommerce Subscriptions active).

## Test

```bash
pytest subscription-missing-saved-card-token/python
node --test subscription-missing-saved-card-token/node
```
