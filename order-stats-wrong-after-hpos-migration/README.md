# Order stats wrong after HPOS migration

After a store moves to High-Performance Order Storage (HPOS), the real orders are correct in `wp_wc_orders`, but the WooCommerce Analytics stats tables can be left stale or missing rows for orders that existed before or during the move. Reports like Total sales or Orders count then disagree with what a manual count of orders shows. This job walks recent orders through the REST API, compares each one against its Analytics report row, and resyncs any order whose stats row is missing, has a stale status, or has the wrong total, by re-saving the order so WooCommerce rebuilds its stats row the same way the built-in "Regenerate data" tool does. Read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/order-stats-wrong-after-hpos-migration/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="90"
export DRY_RUN="true"   # start safe, change to false to write

python order-stats-wrong-after-hpos-migration/python/resync_order_stats.py
node   order-stats-wrong-after-hpos-migration/node/resync-order-stats.js
```

`decide` is a pure function: an order is flagged for resync only when its status should be counted in Analytics and its stats row is missing, stale, or off on the total by more than a cent. It never changes an order's real data, it only re-saves the same status to make WooCommerce rebuild the stats row. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest order-stats-wrong-after-hpos-migration/python
node --test order-stats-wrong-after-hpos-migration/node
```
