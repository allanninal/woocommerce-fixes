# Webhook cannot find the order (missing PaymentIntent ID)

The payment succeeded on Stripe but the order never saved its PaymentIntent ID, so the webhook logs `Could not find order via intent ID` and gives up. These orders also cannot be refunded from the admin. This repair searches Stripe by `metadata.order_id`, recovers the `pi_` and `ch_` IDs, and writes them back onto the order.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/missing-intent-id-webhook-cannot-match-order/

## Run it

```bash
export DRY_RUN="true"

python missing-intent-id-webhook-cannot-match-order/python/backfill_intent_id.py
node   missing-intent-id-webhook-cannot-match-order/node/backfill-intent-id.js
```

## Test

```bash
pytest missing-intent-id-webhook-cannot-match-order/python
node --test missing-intent-id-webhook-cannot-match-order/node
```
