# Coupon usage count undercounts

WooCommerce tracks how many times a coupon was used with a single stored number, usage_count. Two checkouts that apply the same coupon at nearly the same moment can both read the old number and both write back old_number + 1, so one use is lost, and a cancelled or refunded order can also fail to give its use back. This job recounts real usage from orders that actually used the coupon, confirms each one against Stripe (the order's PaymentIntent must show succeeded), and corrects the coupon's stored usage_count to match reality.

**Full guide:** https://www.allanninal.dev/woocommerce/coupon-usage-count-undercounts/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # start safe, change to false to write

python coupon-usage-count-undercounts/python/recount_coupon_usage.py
node   coupon-usage-count-undercounts/node/recount-coupon-usage.js
```

`decide` is a pure function: it compares the coupon's stored usage_count to the real count of orders confirmed paid in Stripe, and says whether to correct it. Start with `DRY_RUN=true` to review the list before anything writes.

## Test

```bash
pytest coupon-usage-count-undercounts/python
node --test coupon-usage-count-undercounts/node
```
