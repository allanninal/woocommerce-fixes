# Coupon usage counted twice via REST

An order created through `POST /wp-json/wc/v3/orders` with a coupon already attached, then updated again through the REST API (a retry, a fulfillment step, or an integration that both creates and later PUTs the order), can make WooCommerce run its usage-count hook more than once for that one order. Each run bumps the coupon's `usage_count`, so a single redemption gets counted twice and the coupon can hit its `usage_limit` long before it should. This script treats Stripe as the source of truth for "was this order paid exactly once," counts each verified order only once no matter how many times it was re-saved, and lowers an inflated `usage_count` back to the correct number.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/coupon-usage-counted-twice-via-rest/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export COUPON_CODES="SAVE10,WELCOME20"
export DRY_RUN="true"

python coupon-usage-counted-twice-via-rest/python/coupon_usage_dedupe.py
node   coupon-usage-counted-twice-via-rest/node/coupon-usage-dedupe.js
```

`decide` is a pure function: a coupon is only corrected when its stored `usage_count` is higher than the number of orders that Stripe confirms were genuinely paid, once each. It never touches a coupon whose count looks too low, since that points to a different bug. Start with `DRY_RUN=true` to review the plan before it writes.

## Test

```bash
pytest coupon-usage-counted-twice-via-rest/python
node --test coupon-usage-counted-twice-via-rest/node/*.test.js
```
