# Subscription price drifts from the product

A product's regular price changes, but a running subscription is expected to keep billing at the price the customer signed up for, that part is normal. The bug this catches is a subscription whose stored line item silently disagrees with what Stripe actually collected on its last renewal, usually from a manual admin edit, an import, or a currency or tax change that left the row inconsistent. This job walks active subscriptions, reads the PaymentIntent behind the last billed order, and reports any subscription whose total does not match what Stripe actually charged. It can optionally realign the subscription's line item to the Stripe amount, since that is the true record of what the customer agreed to pay.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/subscription-price-drifts-from-the-product/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRIFT_TOLERANCE_CENTS="1"
export AUTO_REPAIR="false"   # true also rewrites the drifted line item
export DRY_RUN="true"

python subscription-price-drifts-from-the-product/python/subscription_price_drift.py
node   subscription-price-drifts-from-the-product/node/subscription-price-drift.js
```

`decide` is a pure function: a subscription is flagged only when it is active, has a billed order with a succeeded Stripe PaymentIntent attached, and the subscription's stored total disagrees with the amount Stripe actually collected by more than `DRIFT_TOLERANCE_CENTS`. It is read only by default (it just adds a note). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest subscription-price-drifts-from-the-product/python
node --test subscription-price-drifts-from-the-product/node
```
