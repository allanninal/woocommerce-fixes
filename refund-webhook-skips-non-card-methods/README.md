# Refund webhook skips non-card methods

Refunds on iDEAL, EPS, giropay, or SEPA never flip the WooCommerce order to Refunded, because the `charge.refunded` handler matched the payment method as exactly `stripe` while these are stored as `stripe_ideal`, `stripe_sepa_debit`, and so on. This repair finds orders paid with a `stripe_` alternative method, compares the refund on the Stripe charge against WooCommerce, records the difference with `api_refund` false, and marks fully refunded orders Refunded.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/refund-webhook-skips-non-card-methods/

## Run it

```bash
export DRY_RUN="true"

python refund-webhook-skips-non-card-methods/python/sync_apm_refunds.py
node   refund-webhook-skips-non-card-methods/node/sync-apm-refunds.js
```

The `api_refund` false flag records the refund in WooCommerce without asking Stripe to move money again.

## Test

```bash
pytest refund-webhook-skips-non-card-methods/python
node --test refund-webhook-skips-non-card-methods/node
```
