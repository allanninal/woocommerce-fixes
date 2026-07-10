# Duplicate customer accounts at checkout

A checkout race, a double click, a slow network retry, or two open tabs, can call WooCommerce's "create account" step twice before the first request finishes, so the store ends up with two separate customer accounts for one shopper: one with the order history, one empty. This job walks recent customers, groups them by a normalized email, and for each group reads the saved Stripe PaymentIntent on their orders to confirm both accounts really were paid by the same person before it reports a merge plan. Read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/duplicate-customer-accounts-at-checkout/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export DRY_RUN="true"   # start safe, change to false to write

python duplicate-customer-accounts-at-checkout/python/find_duplicate_accounts.py
node   duplicate-customer-accounts-at-checkout/node/find-duplicate-accounts.js
```

`decide` is a pure function: two accounts sharing an email are only merged automatically when the duplicate has no orders, or when both accounts' orders trace to the same Stripe customer id. If the orders trace to two different Stripe customers, the pair is flagged for a human to review instead of merged. Start with `DRY_RUN=true` to see the report before anything writes.

## Test

```bash
pytest duplicate-customer-accounts-at-checkout/python
node --test duplicate-customer-accounts-at-checkout/node
```
