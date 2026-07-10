# Record Stripe fees on orders

WooCommerce reports show the gross order total, not what you actually kept after Stripe's processing fee. This job walks recent paid orders, reads the Stripe balance transaction behind each charge, and saves the fee and net onto the order as meta (`_stripe_fee`, `_stripe_net`), so your reporting can show real profit. It only writes to orders that do not have the fee recorded yet.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/record-stripe-fees-on-orders/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="14"
export DRY_RUN="true"

python record-stripe-fees-on-orders/python/record_fees.py
node   record-stripe-fees-on-orders/node/record-fees.js
```

`fee_and_net`, `has_fee_recorded`, and `intent_id_of` are pure functions: the fee and net are read from the Stripe balance transaction in minor units and converted to major units, and an order is skipped if it already has the fee. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest record-stripe-fees-on-orders/python
node --test record-stripe-fees-on-orders/node
```
