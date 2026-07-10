# New card not linked to the subscription

A customer updated their card, but the subscription still stores the old token, so renewals keep charging the old card and fail. This reconciler lists active subscriptions, compares each stored card token to the customer's current default payment method on Stripe, and repoints the ones that drifted so the next renewal uses the right card.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/new-card-not-linked-to-subscription/

## Run it

```bash
export DRY_RUN="true"

python new-card-not-linked-to-subscription/python/repoint_sub_card.py
node   new-card-not-linked-to-subscription/node/repoint-sub-card.js
```

## Test

```bash
pytest new-card-not-linked-to-subscription/python
node --test new-card-not-linked-to-subscription/node
```
