# Declined card leaves the order stuck on Pending

A declined card leaves the WooCommerce order on Pending instead of Failed, so stock stays reserved and the orders list fills with dead checkouts. This script lists old pending Stripe orders, reads each PaymentIntent, and moves the genuinely declined ones (status `requires_payment_method` with a `last_payment_error`) to Failed, which releases the held stock.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/declined-card-order-stuck-pending/

## Run it

```bash
export DRY_RUN="true"
export MIN_AGE_HOURS="2"   # skip checkouts that may still be in progress

python declined-card-order-stuck-pending/python/fail_declined.py
node   declined-card-order-stuck-pending/node/fail-declined.js
```

## Test

```bash
pytest declined-card-order-stuck-pending/python
node --test declined-card-order-stuck-pending/node
```
