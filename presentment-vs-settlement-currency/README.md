# Presentment vs settlement currency

A buyer can check out in one currency (the presentment currency, what WooCommerce shows and stores as the order total) while Stripe actually settles the charge into your payout currency (the settlement currency) at its own exchange rate. WooCommerce never sees that conversion, so the order total and your accounting books disagree with what Stripe actually paid out. This job walks recent paid orders, reads the Stripe balance transaction behind each charge, and when the presentment currency does not match the settlement currency, writes the settled amount, currency, and exchange rate onto the order as meta so reports reconcile.

**Full guide:** https://www.allanninal.dev/woocommerce/presentment-vs-settlement-currency/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="14"
export DRY_RUN="true"

python presentment-vs-settlement-currency/python/record_settlement_currency.py
node   presentment-vs-settlement-currency/node/record-settlement-currency.js
```

`decide` is a pure function: an order is only recorded when it is paid, has no settlement meta yet, and Stripe's balance transaction shows a settlement currency different from the order's presentment currency with a real exchange rate attached. Money math stays in minor units (cents) until the final note is written. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest presentment-vs-settlement-currency/python
node --test presentment-vs-settlement-currency/node
```
