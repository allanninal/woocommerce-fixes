# Card not saved for future renewals

A subscription's first order can be paid in full while the Stripe PaymentIntent behind it was built without `setup_future_usage`, so no reusable card ever gets attached to the customer. WooCommerce marks the order paid and nobody notices until the renewal date arrives with nothing to charge. This script checks subscriptions whose renewal is coming up soon, reads the Stripe PaymentIntent from the parent order's meta, and flags any subscription where the payment succeeded but no reusable customer and payment method were ever saved, so the shop can ask for a card while there is still time.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/card-not-saved-for-future-renewals/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DAYS_BEFORE_RENEWAL="3"
export REVIEW_HOLD="false"   # true also moves flagged subscriptions to on-hold
export DRY_RUN="true"

python card-not-saved-for-future-renewals/python/find_unsaved_renewal_cards.py
node   card-not-saved-for-future-renewals/node/find-unsaved-renewal-cards.js
```

`decide` is a pure function: a subscription is flagged only when its renewal is due soon, its parent order paid through a succeeded Stripe PaymentIntent, and that PaymentIntent never attached a reusable customer and payment method. It is read only by default (it just adds a note). Needs the WooCommerce Subscriptions REST API. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest card-not-saved-for-future-renewals/python
node --test card-not-saved-for-future-renewals/node
```
