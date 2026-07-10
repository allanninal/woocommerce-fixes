# Rounding drifts the order total by a cent

WooCommerce can round each line item's tax separately while Stripe (or the card network) rounds the grand total once, so the WooCommerce order total and the amount Stripe actually charged land a cent or two apart even though nothing is wrong with the sale. This job walks recent paid orders, reads the saved Stripe PaymentIntent, compares both amounts in minor units (cents), and flags any order where the drift is a real mismatch instead of ordinary rounding, by adding an order note. Read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/rounding-drifts-the-order-total-by-a-cent/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export ROUNDING_TOLERANCE_CENTS="1"
export DRY_RUN="true"

python rounding-drifts-the-order-total-by-a-cent/python/detect_rounding_drift.py
node   rounding-drifts-the-order-total-by-a-cent/node/detect-rounding-drift.js
```

`decide` is a pure function: it takes an order and its Stripe PaymentIntent, does all money math in cents, and returns `ok`, `drift` (within tolerance, ordinary rounding), `mismatch` (a real problem), `orphan` (no matching Stripe charge), or `skip` (order not paid yet). It never writes on its own. Start with `DRY_RUN=true` to review the list before it adds any order notes.

## Test

```bash
pytest rounding-drifts-the-order-total-by-a-cent/python
node --test rounding-drifts-the-order-total-by-a-cent/node
```
