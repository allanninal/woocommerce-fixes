# Cannot change the card twice

A subscription's saved Stripe PaymentMethod can go stale after the first successful card change, for example when a cleanup script detaches it during a duplicate customer merge, or the shopper removes it from a Stripe-hosted customer portal. WooCommerce never hears about it, so the next attempt to change the card fails silently against the dead reference and the subscription is stuck. This job walks active and on-hold subscriptions, checks each saved PaymentMethod against Stripe, and clears any reference that is confirmed dead so the customer's next attempt goes through.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/cannot-change-the-card-twice/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python cannot-change-the-card-twice/python/clear_stale_card.py
node   cannot-change-the-card-twice/node/clear-stale-card.js
```

`decide` is a pure function: a subscription is only cleared when its saved PaymentMethod id no longer exists in Stripe or no longer belongs to the Stripe Customer on file. It never guesses a replacement card, it only removes the stale reference and adds a note. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest cannot-change-the-card-twice/python
node --test cannot-change-the-card-twice/node
```
