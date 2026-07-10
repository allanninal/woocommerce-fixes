# Limited-payment coupon miscounts

A WooCommerce Subscriptions coupon can be set to discount only a subscription's first N renewal payments. Each subscription keeps a running counter of how many payments that coupon has already discounted. A failed-then-retried renewal, or a plan switch, can make that counter skip a count or add one twice, so the coupon keeps discounting past its real limit (a quiet revenue leak) or stops discounting a payment early (a support ticket). This job recounts the true number of discounted payments from the subscription's own paid renewal order history, confirmed against Stripe, and repairs the stored counter when it disagrees.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/limited-payment-coupon-miscounts/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export COUPON_CODE="vip10"
export DRY_RUN="true"

python limited-payment-coupon-miscounts/python/recount_limited_payment_coupons.py
node   limited-payment-coupon-miscounts/node/recount-limited-payment-coupons.js
```

`decide` is a pure function: a subscription's stored counter is repaired only when it disagrees with the real count of paid, coupon-carrying renewal orders that Stripe confirms as succeeded. Start with `DRY_RUN=true` to review the corrected numbers first.

## Test

```bash
pytest limited-payment-coupon-miscounts/python
node --test limited-payment-coupon-miscounts/node
```
