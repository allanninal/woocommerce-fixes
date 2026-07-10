# Zero cost renewal orphaned by block checkout

When a WooCommerce Subscriptions renewal nets to $0.00 (a 100% off coupon, a switch credit, a free trial that converted with a balance applied), WooCommerce skips Stripe entirely since there is nothing to charge. The classic checkout flow still calls `payment_complete()` on the order for a $0 total, but the block checkout flow does not run that step for zero cost renewals. The renewal order is created and then just sits on Pending or On hold, no Stripe PaymentIntent is ever attached, no renewal note is added, and the subscription's next payment date never advances. This job finds renewal orders that are genuinely zero cost, still unpaid, and have no PaymentIntent, and completes them the way `payment_complete()` would have. It never touches an order with a real PaymentIntent or a non-zero total.

**Full guide:** https://www.allanninal.dev/woocommerce/zero-cost-renewal-orphaned-by-block-checkout/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="14"
export DRY_RUN="true"   # start safe, change to false to write

python zero-cost-renewal-orphaned-by-block-checkout/python/complete_zero_cost_renewal.py
node   zero-cost-renewal-orphaned-by-block-checkout/node/complete-zero-cost-renewal.js
```

`decide` is a pure function: a renewal order is completed only when it carries the `_subscription_renewal` meta, is still pending or on-hold, totals $0.00 within a cent, and has no Stripe PaymentIntent on it. Anything with a real PaymentIntent or a non-zero total is left alone, that is a stuck payment, not an orphaned zero cost renewal. Start with `DRY_RUN=true` to review the list before it writes anything.

## Test

```bash
pytest zero-cost-renewal-orphaned-by-block-checkout/python
node --test zero-cost-renewal-orphaned-by-block-checkout/node
```
