# Failed orders inflate and lock coupons

WooCommerce increases a coupon's usage_count, and records the billing email under used_by, the moment an order is placed with that coupon attached, before payment is confirmed. When the order later fails, a declined card, an abandoned Stripe PaymentIntent, a gateway error, WooCommerce is supposed to release that usage back, but a lot of failure paths never call it. The coupon then looks used up, or a single customer looks like they hit usage_limit_per_user, when Stripe never took a payment. This job walks recent failed orders, checks the Stripe PaymentIntent tied to each one, and releases the coupon usage slot for any failed order that is still holding one.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/failed-orders-inflate-and-lock-coupons/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="14"
export DRY_RUN="true"

python failed-orders-inflate-and-lock-coupons/python/release_failed_coupons.py
node   failed-orders-inflate-and-lock-coupons/node/release-failed-coupons.js
```

`decide` is a pure function: a coupon usage slot is released only when the order failed or was cancelled, Stripe does not show the payment as succeeded, and that order's identity is still listed on the coupon's used_by. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest failed-orders-inflate-and-lock-coupons/python
node --test failed-orders-inflate-and-lock-coupons/node/release-failed-coupons.test.js
```
