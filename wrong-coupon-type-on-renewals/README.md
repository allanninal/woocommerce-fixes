# Wrong coupon type on renewals

A one time coupon (a normal percent, fixed cart, or fixed product discount) can end up sitting on a subscription's renewal orders even though WooCommerce Subscriptions is only supposed to carry recurring coupon types (recurring_percent, recurring_fixed_cart, recurring_fixed_product) forward. When that happens, every renewal quietly keeps discounting a customer who should be paying full price. This job walks each active subscription's renewal orders, looks up the real discount type of every applied coupon, and strips any coupon that is not a recurring type, then recalculates the order total and leaves a note explaining what changed.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/wrong-coupon-type-on-renewals/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_SUBSCRIPTIONS="200"
export DRY_RUN="true"

python wrong-coupon-type-on-renewals/python/strip_bad_renewal_coupons.py
node   wrong-coupon-type-on-renewals/node/strip-bad-renewal-coupons.js
```

`decide` is a pure function: a renewal order is only ever flagged for a fix when it is a real renewal, it is in an editable status, and it carries at least one coupon whose discount type is not one of the three recurring types. Start with `DRY_RUN=true` to see the exact list of renewal orders and coupon codes before anything is written.

## Test

```bash
pytest wrong-coupon-type-on-renewals/python
node --test wrong-coupon-type-on-renewals/node
```
