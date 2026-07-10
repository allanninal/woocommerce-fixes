# Duplicate saved cards

A retried checkout, a re-added card during a plan upgrade, or a customer portal session can all attach a fresh Stripe PaymentMethod for a card the customer already has on file. Stripe never merges these for you, so the same card sits on the customer two, three, sometimes five times, cluttering "my payment methods" and any renewal picker. This job walks each customer's saved cards, groups them by card fingerprint, keeps the one an active subscription actually renews with (or the newest one if none is in use), and detaches the rest.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/duplicate-saved-cards/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python duplicate-saved-cards/python/dedupe_saved_cards.py
node   duplicate-saved-cards/node/dedupe-saved-cards.js
```

`decide` is a pure function: given every saved card that shares one fingerprint, it keeps whichever card an active subscription still points at, or the newest card if none are in use, and marks the rest for detach. It never touches a card that is the only copy. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest duplicate-saved-cards/python
node --test duplicate-saved-cards/node
```
