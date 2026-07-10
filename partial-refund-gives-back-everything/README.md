# Partial refund gives back everything

An order whose Stripe PaymentIntent was captured for less than the order total, a manual capture, a phone order finished outside checkout, a split payment, throws off WooCommerce's refund math. Ask for a small partial refund in wp-admin and the gateway can send Stripe a refund that is missing its amount, or one larger than what is actually left, so Stripe returns the entire remaining balance instead of the small amount the shop manager intended. This script compares what WooCommerce's refund record says against what Stripe's charge actually shows and flags the gap with an order note. It never moves money and never edits amounts, it only reports.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/partial-refund-gives-back-everything/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_HOURS="72"
export DRY_RUN="true"

python partial-refund-gives-back-everything/python/audit_refunds.py
node   partial-refund-gives-back-everything/node/audit-refunds.js
```

`decide` is a pure function: an order is flagged only when Stripe's `charge.amount_refunded` is more than a cent above the WooCommerce refund record for that order. It is read only by default (it just adds a note). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest partial-refund-gives-back-everything/python
node --test partial-refund-gives-back-everything/node
```
