# Double charge from a redirect and webhook race

Now and then a customer is billed twice for one order, because the browser redirect and the Stripe webhook both complete the same payment. This reconciler lists recent charges, groups them by `metadata.order_id`, finds orders with more than one succeeded charge for the same amount, keeps the charge recorded on the order, and refunds the extra.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/duplicate-charge-redirect-webhook-race/

## Run it

```bash
export DRY_RUN="true"   # refunds move real money, so start safe

python duplicate-charge-redirect-webhook-race/python/refund_duplicates.py
node   duplicate-charge-redirect-webhook-race/node/refund-duplicates.js
```

## Test

```bash
pytest duplicate-charge-redirect-webhook-race/python
node --test duplicate-charge-redirect-webhook-race/node
```
