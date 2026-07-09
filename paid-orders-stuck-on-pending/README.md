# Paid orders stuck on Pending

The Stripe charge succeeded but the WooCommerce order is still on Pending payment because the webhook that finishes the order was lost. This reconciler reads succeeded PaymentIntents from Stripe, matches each to its order by `metadata.order_id`, and moves any still unpaid order to Processing when the amount matches.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/paid-orders-stuck-on-pending/

## Run it

```bash
export DRY_RUN="true"   # start safe

# Python
pip install stripe requests
python paid-orders-stuck-on-pending/python/reconcile_pending.py

# Node
npm install stripe
node paid-orders-stuck-on-pending/node/reconcile-pending.js
```

Run it on a schedule with cron every five to ten minutes. It only acts on orders that are still pending, so running it often is safe.

## Test

```bash
pytest paid-orders-stuck-on-pending/python
node --test paid-orders-stuck-on-pending/node
```
