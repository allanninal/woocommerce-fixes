# Duplicate renewal orders in one cycle

WooCommerce Subscriptions can create two renewal orders for the same billing cycle when the scheduled renewal action fires twice, for example after Action Scheduler retries a slow run, or a shop manager clicks "Process renewal" while the cron copy is still mid flight. This job walks recent renewal orders, groups them by subscription id and renewal date, and for every group of more than one keeps a single order (the paid one if there is one, otherwise the oldest) and cancels the rest, but only when the extra order was never actually charged. Anything that looks genuinely paid on both orders is flagged for a human instead of cancelled automatically.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/duplicate-renewal-orders-in-one-cycle/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="3"
export DRY_RUN="true"   # start safe, change to false to write

python duplicate-renewal-orders-in-one-cycle/python/cancel_duplicate_renewals.py
node   duplicate-renewal-orders-in-one-cycle/node/cancel-duplicate-renewals.js
```

`decide` is a pure function: it only cancels an order when a group shares the same subscription and renewal date, the group has more than one order, and the order to cancel was never actually paid. Two orders that both look paid are flagged for manual review instead of being touched. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest duplicate-renewal-orders-in-one-cycle/python
node --test duplicate-renewal-orders-in-one-cycle/node
```
