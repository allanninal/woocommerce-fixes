# Recreate subs after account move

When a store moves to a new Stripe account (a merge, a platform migration, or a new Connect account), every saved card token that lived on the old account stops working. WooCommerce Subscriptions still points renewal orders at the old Stripe customer and payment method id, so the next scheduled renewal fails with an error like "No such customer" or "No such payment_method". This job finds subscriptions still tied to the old Stripe account, and for any customer who already has a valid, chargeable payment method on the new account, it re-points the subscription so the next renewal can actually be charged.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/recreate-subs-after-account-move/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python recreate-subs-after-account-move/python/recreate_subs.py
node   recreate-subs-after-account-move/node/recreate-subs.js
```

`decide` is a pure function: a subscription is only recreated when it is active or on-hold, it has an old Stripe customer id saved, and the customer already has a valid, chargeable payment method on the new Stripe account. It is safe to run again and again, since it skips anything already pointing at the current token. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest recreate-subs-after-account-move/python
node --test recreate-subs-after-account-move/node
```
