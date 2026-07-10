# Order tax off by a cent (frontend vs API)

The checkout page rounds tax per line item as the buyer shops, but the order that gets saved can end up with a `total_tax` that was rounded a different way, so the number a shopper saw at checkout and the number stored on the order can disagree by a cent or two. This job walks recent settled orders, recomputes the expected tax by re-adding each line item's own tax the same way the cart does, and flags or fixes any order whose stored `total_tax` drifts from that recomputed value.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/order-tax-off-by-a-cent-frontend-vs-api/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export MAX_DRIFT_CENTS="3"   # drift larger than this is flagged for review, not auto fixed
export DRY_RUN="true"

python order-tax-off-by-a-cent-frontend-vs-api/python/reconcile_order_tax.py
node   order-tax-off-by-a-cent-frontend-vs-api/node/reconcile-order-tax.js
```

`decide` is a pure function: it compares the order's stored `total_tax` in cents against the tax recomputed from the order's own line items, shipping lines, and fee lines. A tiny drift within `MAX_DRIFT_CENTS` gets fixed automatically, a larger drift is flagged for a human, and unsettled orders are skipped. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest order-tax-off-by-a-cent-frontend-vs-api/python
node --test order-tax-off-by-a-cent-frontend-vs-api/node/*.test.js
```
