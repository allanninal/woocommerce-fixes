# Orphaned subscriptions with no customer

A WooCommerce Subscription is supposed to belong to a WordPress user, stored as `customer_id` on the subscription. A deleted account, a GDPR erasure request, a failed account step during signup, or a bad import can leave a subscription with `customer_id` set to 0 while Stripe is still billing the saved card behind it every cycle. This job walks recent subscriptions, and either reattaches the ones Stripe metadata can still identify, or flags the ones that are genuinely orphaned for a human to review.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/orphaned-subscriptions-with-no-customer/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="90"
export DRY_RUN="true"

python orphaned-subscriptions-with-no-customer/python/find_orphaned_subscriptions.py
node   orphaned-subscriptions-with-no-customer/node/find-orphaned-subscriptions.js
```

`decide` is a pure function: a subscription is only touched when it is in an active-like status (active, on-hold, or pending-cancel) and has no working `customer_id`. It reattaches when Stripe's PaymentIntent metadata still names a real WooCommerce user, and otherwise flags the subscription for review. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest orphaned-subscriptions-with-no-customer/python
node --test orphaned-subscriptions-with-no-customer/node
```
