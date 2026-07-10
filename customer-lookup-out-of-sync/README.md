# Customer lookup out of sync

The WooCommerce customer lookup table caches each customer's order count, total spent, and last order date so reports and the Customers screen can load fast without scanning every order. That cache is supposed to update itself as orders are placed, paid, and refunded, but a stuck scheduled action, a bulk import, or a direct database edit can leave it holding stale numbers long after the real orders moved on. This job walks every customer, recalculates their real totals straight from the WooCommerce REST API, compares that to the stored row, and rewrites only the rows that disagree. It also flags a saved Stripe customer id that no longer resolves.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/customer-lookup-out-of-sync/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export STRIPE_SECRET_KEY="sk_live_..."
export DRY_RUN="true"

python customer-lookup-out-of-sync/python/rebuild_customer_lookup.py
node   customer-lookup-out-of-sync/node/rebuild-customer-lookup.js
```

`decide` is a pure function: a customer's lookup row is rebuilt only when a fresh recalculation from their real, paid or completed orders disagrees with the stored order count, total spent, or last order date. It is read only by default. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest customer-lookup-out-of-sync/python
node --test customer-lookup-out-of-sync/node
```
