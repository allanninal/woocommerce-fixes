# Recurring coupon dropped on switch

When a customer switches a subscription (upgrade, downgrade, or a plan change), WooCommerce Subscriptions rebuilds the line items on the resulting subscription but does not carry over a recurring coupon that was active before the switch. The switch order itself looks fine, since the one-time proration is correct, but every renewal after the switch bills full price. This job walks recent switch orders, compares the recurring coupons on the subscription before and after the switch, confirms the switch order actually has a succeeded Stripe payment behind it, and reapplies any recurring coupon that was dropped.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/recurring-coupon-dropped-on-switch/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"

python recurring-coupon-dropped-on-switch/python/reapply_switch_coupon.py
node   recurring-coupon-dropped-on-switch/node/reapply-switch-coupon.js
```

`decide` is a pure function: a subscription is only repaired when a recurring coupon it had before the switch is missing after the switch, and the switch order has a Stripe PaymentIntent that succeeded. Start with `DRY_RUN=true` to review the list before it writes anything.

## Test

```bash
pytest recurring-coupon-dropped-on-switch/python
node --test recurring-coupon-dropped-on-switch/node
```
