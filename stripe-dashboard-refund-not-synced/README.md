# Stripe dashboard refund not synced to WooCommerce

A refund made in the Stripe dashboard never reaches WooCommerce, so the order still shows its full total and revenue is overstated. This reconciler lists Stripe refunds, maps each to its order, compares against the refunds WooCommerce already recorded, and writes in anything missing with `api_refund` set to `false`, so the customer is never refunded twice.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/stripe-dashboard-refund-not-synced/

## Run it

```bash
export DRY_RUN="true"

python stripe-dashboard-refund-not-synced/python/sync_refunds.py
node   stripe-dashboard-refund-not-synced/node/sync-refunds.js
```

The `api_refund` false flag is the key. It records the refund in WooCommerce for reporting without asking Stripe to move money again.

## Test

```bash
pytest stripe-dashboard-refund-not-synced/python
node --test stripe-dashboard-refund-not-synced/node
```
