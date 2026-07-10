# Currency not enabled on Stripe

An order can fail, or be about to fail, because its currency was never enabled on the connected Stripe account: a new store currency, a multi-currency plugin, or a manual order in a currency Stripe was never approved for. This job reads the account's accepted currencies once, then walks recent pending, on-hold, and failed orders and flags any whose currency Stripe will reject or already rejected, by adding a clear order note (and optionally moving it to on-hold for review), before the shopper hits a confusing decline.

**Full guide:** https://www.allanninal.dev/woocommerce/currency-not-enabled-on-stripe/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export REVIEW_HOLD="false"   # true also moves flagged orders to on-hold
export DRY_RUN="true"

python currency-not-enabled-on-stripe/python/detect_currency_not_enabled.py
node   currency-not-enabled-on-stripe/node/detect-currency-not-enabled.js
```

`decide` is a pure function: an order is flagged only when its currency is not in the Stripe account's accepted list, or Stripe already returned a currency related error code. It is read only by default (it just adds a note). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest currency-not-enabled-on-stripe/python
node --test currency-not-enabled-on-stripe/node
```
