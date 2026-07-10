# Card change flips the subscription to Pending

A customer changes the card on a WooCommerce subscription and the bank requires a 3D Secure check, so WooCommerce Subscriptions moves the subscription to Pending while it waits for the result. When the confirmation that the check succeeded never reaches the store (a missed redirect, a lost webhook, a caching layer swallowing the return URL), the subscription is left on Pending even though the card was verified and saved, and renewals silently stop. This job lists Pending subscriptions, confirms on Stripe that the saved SetupIntent succeeded with a payment method that matches the subscription's current card, and only then sets the subscription back to active.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/card-change-flips-sub-to-pending/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # start safe, change to false to write

python card-change-flips-sub-to-pending/python/resume_pending_after_card_change.py
node   card-change-flips-sub-to-pending/node/resume-pending-after-card-change.js
```

`decide` is a pure function: a Pending subscription is only resumed when the saved SetupIntent shows `succeeded` and its payment method matches the card currently stored on the subscription. Anything still waiting on the customer, or with a card that does not match, is left alone (and mismatches are logged as a warning for a human to check). Start with `DRY_RUN=true` to review the list before it writes.

## Test

```bash
pytest card-change-flips-sub-to-pending/python
node --test card-change-flips-sub-to-pending/node
```
