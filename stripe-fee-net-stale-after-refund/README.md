# Stripe fee and net stale after a refund

After a partial refund the saved `_stripe_net` and `_stripe_fee` on the WooCommerce order still show the pre-refund figures, so accounting overstates what you kept. This repair reads each order's Stripe charge with its refunds, recomputes the fee and net from the balance transactions, and writes back the corrected values when they are stale. Reporting only, it never changes the order total.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/stripe-fee-net-stale-after-refund/

## Run it

```bash
export DRY_RUN="true"

python stripe-fee-net-stale-after-refund/python/fix_fee_net.py
node   stripe-fee-net-stale-after-refund/node/fix-fee-net.js
```

## Test

```bash
pytest stripe-fee-net-stale-after-refund/python
node --test stripe-fee-net-stale-after-refund/node
```
