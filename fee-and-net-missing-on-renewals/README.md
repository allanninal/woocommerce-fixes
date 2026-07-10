# Fee and net missing on renewals

An update to a payment plugin, WooCommerce Subscriptions, or a custom snippet can quietly stop the code that saves the Stripe processing fee and net amount from firing on renewal orders, while it keeps working fine on the original signup order. The renewal is charged correctly and marked paid, it is just missing the `_stripe_fee` and `_stripe_net` meta your profit reports depend on. This job walks recent paid renewal orders, reads the balance transaction behind the saved Stripe PaymentIntent, and backfills the fee and net onto any renewal order that is missing them. Read only by default. Safe to run again and again.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/fee-and-net-missing-on-renewals/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="90"
export DRY_RUN="true"   # start safe, change to false to write

python fee-and-net-missing-on-renewals/python/backfill_renewal_fees.py
node   fee-and-net-missing-on-renewals/node/backfill-renewal-fees.js
```

`decide` is a pure function: a renewal order is only fixed when it is paid, it is missing the fee and net meta, and Stripe has a balance transaction with both values. Orders that already have the fee and net, are not renewals, or are not yet paid are skipped untouched. Money math stays in cents until the final write. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest fee-and-net-missing-on-renewals/python
node --test fee-and-net-missing-on-renewals/node
```
