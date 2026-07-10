# Partial capture total mismatch

A store on manual capture can capture less than the full authorized amount, for a split shipment, a stock shortfall, or a deliberate partial charge. Stripe's PaymentIntent then shows the real amount taken in `amount_received`, but the WooCommerce order was created with the original, larger total and nothing updates it. The order overstates what the buyer actually paid. This job walks recent paid orders, reads the saved Stripe PaymentIntent id, and for any order whose total is higher than what Stripe actually captured, corrects the order total to match and adds a note explaining the change.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/partial-capture-total-mismatch/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="14"
export MISMATCH_TOLERANCE_MINOR="1"
export DRY_RUN="true"

python partial-capture-total-mismatch/python/sync_partial_capture.py
node   partial-capture-total-mismatch/node/sync-partial-capture.js
```

`decide` is a pure function: an order is fixed only when it is in a paid state, its PaymentIntent has finished capturing (no `amount_capturable` left), and the amount Stripe actually received is lower than the order total by more than the tolerance. Orders where the total is already lower than the charge are flagged instead of auto-fixed, since that points at a different problem. Start with `DRY_RUN=true` to review the list before it writes.

## Test

```bash
pytest partial-capture-total-mismatch/python
node --test partial-capture-total-mismatch/node
```
