# SEPA renewal stays active on fail

SEPA Direct Debit confirms in two steps. Stripe marks the PaymentIntent processing the moment the mandate is charged, so WooCommerce marks the renewal order paid and keeps the subscription active right away, but the bank can still return the debit unpaid two to fourteen days later. If that later failure webhook is missed, the renewal order and the subscription never learn the payment actually failed. This job walks recent paid renewal orders, rereads the PaymentIntent status straight from Stripe, and moves any order whose SEPA mandate truly failed to on-hold so WooCommerce Subscriptions can start its automatic payment retry (dunning).

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/sepa-renewal-stays-active-on-fail/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="14"
export DRY_RUN="true"   # start safe, change to false to write

python sepa-renewal-stays-active-on-fail/python/repair_sepa_renewal.py
node   sepa-renewal-stays-active-on-fail/node/repair-sepa-renewal.js
```

`decide` is a pure function: an order is repaired only when it is still marked paid while Stripe now shows a real SEPA failure (`requires_payment_method` or `canceled`), not merely still processing. It leaves succeeded payments, already-handled orders, and payments still settling untouched. Start with `DRY_RUN=true` to review the exact list before it writes.

## Test

```bash
pytest sepa-renewal-stays-active-on-fail/python
node --test sepa-renewal-stays-active-on-fail/node
```
