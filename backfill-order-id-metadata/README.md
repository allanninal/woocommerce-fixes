# Backfill order ID metadata

Older orders, orders created through a custom checkout, or PaymentIntents recreated during a gateway migration can succeed without ever getting `order_id` written into their Stripe metadata. The payment is fine, only the label that lets later scripts (reconciliation, refund tooling, Stripe dashboard search) match the PaymentIntent back to its WooCommerce order is missing. This job walks recent paid orders, reads the PaymentIntent id each order already has saved, and writes `order_id` onto that PaymentIntent's metadata in Stripe when it is missing or wrong.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/backfill-order-id-metadata/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="365"
export DRY_RUN="true"   # true also reports the plan, false writes metadata

python backfill-order-id-metadata/python/backfill_order_id_metadata.py
node   backfill-order-id-metadata/node/backfill-order-id-metadata.js
```

`decide` is a pure function: a PaymentIntent is only backfilled when it is missing `order_id`, or has the wrong one, and is in a paid state. It never touches the charge, the amount, or the order status. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest backfill-order-id-metadata/python
node --test backfill-order-id-metadata/node
```
