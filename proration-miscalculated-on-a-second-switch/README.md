# Proration miscalculated on a second switch

A second WooCommerce Subscriptions plan switch inside the same billing cycle should prorate against the price the first switch already set, but the calculation can instead reuse the subscription's price from before either switch happened. That makes the second switch order total wrong, sometimes by the full price of the first switch. This job walks recent switch orders, rebuilds what the proration should have been from the subscription's own order history and plan prices, and flags any switch order whose total, or the linked Stripe charge, does not match. Read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/proration-miscalculated-on-a-second-switch/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"

python proration-miscalculated-on-a-second-switch/python/detect_switch_proration.py
node   proration-miscalculated-on-a-second-switch/node/detect-switch-proration.js
```

`decide` is a pure function: it recomputes the expected proration in minor units (cents) from the switch's cycle data and flags the switch order only when its total, or the amount Stripe actually charged, disagrees with that figure. It is read only by default (it just adds a review note). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest proration-miscalculated-on-a-second-switch/python
node --test proration-miscalculated-on-a-second-switch/node
```
