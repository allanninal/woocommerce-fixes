# Coupon expiry uses UTC not site time

WooCommerce stores a coupon's expiry as a UTC timestamp (`date_expires_gmt`) and compares it against the current UTC time to decide whether the coupon is still valid. The shop owner picks a date in the WordPress admin thinking in site time, but the coupon can die hours before local midnight for stores west of UTC, or drift onto the wrong calendar day entirely. This job reads a store's coupons, works out each one's real expiry moment in site time, and flags (or corrects) any coupon that does not actually expire at the end of the intended local day.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/coupon-expiry-uses-utc-not-site-time/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export SITE_UTC_OFFSET_MINUTES="480"   # e.g. 480 for UTC+8, -300 for UTC-5
export DRY_RUN="true"

python coupon-expiry-uses-utc-not-site-time/python/fix_coupon_expiry_timezone.py
node   coupon-expiry-uses-utc-not-site-time/node/fix-coupon-expiry-timezone.js
```

`decide` is a pure function: a coupon is only corrected when its stored UTC expiry does not land within a minute of 23:59:59 in the store's local time. Start with `DRY_RUN=true` to review the list before it writes.

## Test

```bash
pytest coupon-expiry-uses-utc-not-site-time/python
node --test coupon-expiry-uses-utc-not-site-time/node
```
