# Customer lifetime value drifts

WooCommerce caches each customer's lifetime value instead of summing their orders on every page view, and that cache can drift from reality: a refund that never re-synced, an order edited after the total was cached, or a Stripe refund issued from the Stripe dashboard that never reached WooCommerce at all. This job walks each customer's paid orders, nets out refunds through the WooCommerce REST API, double checks the refund total against Stripe when a PaymentIntent id is on the order, and writes the correct lifetime value back onto the customer. Read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/customer-lifetime-value-drifts/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRIFT_TOLERANCE_CENTS="1"
export DRY_RUN="true"

python customer-lifetime-value-drifts/python/recompute_clv.py
node   customer-lifetime-value-drifts/node/recompute-clv.js
```

`decide` and `compute_customer_clv` (`decide` and `computeCustomerClv` in Node) are pure functions: a customer is flagged only when the recomputed total from their paid orders, minus refunds, disagrees with WooCommerce's cached lifetime value by more than the tolerance. It is read only by default, it only writes when `DRY_RUN=false`. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest customer-lifetime-value-drifts/python
node --test customer-lifetime-value-drifts/node/*.test.js
```
