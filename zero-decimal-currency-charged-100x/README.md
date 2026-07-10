# Zero decimal currency charged 100x

Stripe expects the "amount" it is given in the smallest unit of the currency. For a two decimal currency like USD that is cents, so $50.00 becomes 5000. Zero decimal currencies such as JPY, KRW, and VND have no smaller unit, so PY5000 is just 5000, not 500000. Checkout code that always multiplies the order total by 100 before sending it to Stripe overcharges every zero decimal order by a factor of 100. This job walks recent paid orders in the affected currencies, compares what Stripe actually charged to what the order should have cost, and refunds the difference. Read only by default. Run once, or on a schedule.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/zero-decimal-currency-charged-100x/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export DRY_RUN="true"   # start safe, change to false to write

python zero-decimal-currency-charged-100x/python/fix_zero_decimal_overcharge.py
node   zero-decimal-currency-charged-100x/node/fix-zero-decimal-overcharge.js
```

`decide` is a pure function: an order is flagged for a refund only when its currency is zero decimal, Stripe shows a succeeded charge, and that charge is close to exactly 100 times the order total. Everything else is skipped or reported as a mismatch for a human to check. Start with `DRY_RUN=true` to review the list of affected orders and refund amounts before it writes anything.

## Test

```bash
pytest zero-decimal-currency-charged-100x/python
node --test zero-decimal-currency-charged-100x/node
```
