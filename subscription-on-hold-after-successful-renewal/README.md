# Subscription stuck On-Hold after a successful renewal

The renewal was paid and the order completed, but under some HPOS setups the subscription status change is never saved, so the subscription stays On-Hold and a paying customer looks suspended. This reconciler lists On-Hold subscriptions, confirms each was really paid (paid renewal order, or an active Stripe subscription with a paid invoice), and sets only those back to active.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/subscription-on-hold-after-successful-renewal/

## Run it

```bash
export DRY_RUN="true"

python subscription-on-hold-after-successful-renewal/python/reactivate_paid_subs.py
node   subscription-on-hold-after-successful-renewal/node/reactivate-paid-subs.js
```

Needs the WooCommerce Subscriptions REST API (WooCommerce Subscriptions active). The Stripe check is optional and only used when a Stripe subscription ID is stored on the subscription.

## Test

```bash
pytest subscription-on-hold-after-successful-renewal/python
node --test subscription-on-hold-after-successful-renewal/node
```
