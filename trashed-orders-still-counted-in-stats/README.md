# Trashed orders still counted in stats

WooCommerce Analytics reads its totals from a lookup table, not straight from the order list, and that table is only cleared for an order when the normal "move to Trash" action fires. A direct database delete, a cleanup cron, or a plugin that trashes orders by writing the status column directly can skip that step, so a trashed order keeps showing up in revenue and order count totals. This job walks orders with status `trash`, cross-checks the Stripe PaymentIntent as a safety net so a real, unrefunded sale is never silently hidden, and repairs the ones that should be excluded by setting `_exclude_from_stats` to `yes`.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/trashed-orders-still-counted-in-stats/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export DRY_RUN="true"

python trashed-orders-still-counted-in-stats/python/exclude_trashed_from_stats.py
node   trashed-orders-still-counted-in-stats/node/exclude-trashed-from-stats.js
```

`decide` is a pure function: a trashed order is only repaired (excluded from stats) when it is not already excluded and Stripe agrees there is no live, unrefunded charge behind it. If Stripe still shows a real, unrefunded charge on a trashed order, the script holds it and adds a note for a human instead of hiding real revenue. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest trashed-orders-still-counted-in-stats/python
node --test trashed-orders-still-counted-in-stats/node
```
