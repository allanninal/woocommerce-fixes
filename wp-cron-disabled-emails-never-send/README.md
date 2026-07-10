# WP-Cron disabled, emails never send

Most transactional WooCommerce emails and the entire Action Scheduler queue are dispatched through WP-Cron, which only runs when a visitor loads a page on your site. If `DISABLE_WP_CRON` is set to true with no real system cron calling `wp-cron.php`, or a caching layer serves every request without WordPress ever booting, the queue backs up silently while orders and payments keep working fine. This watchdog reads recent orders and their notes through the WooCommerce REST API, checks how long each one has waited without a confirmation note, and raises a store-level alarm once a real backlog shows up, so you find out from a monitor instead of from an angry customer.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/wp-cron-disabled-emails-never-send/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_HOURS="6"
export STUCK_MINUTES="30"
export DRY_RUN="true"   # true also skips writing the diagnostic note

python wp-cron-disabled-emails-never-send/python/cron_watchdog.py
node   wp-cron-disabled-emails-never-send/node/cron-watchdog.js
```

`decide` and `storeVerdict` are pure functions: an order is flagged as stuck only when it has waited past `STUCK_MINUTES` with no note that looks like a sent confirmation, and the store only raises the alarm once at least three orders are stuck in the same run. It is read only by default, it never changes an order's status or total, and even with `DRY_RUN=false` it only ever adds one diagnostic note. Start with `DRY_RUN=true` to review the verdict first, and run it from a real system cron rather than anything that depends on the WordPress site's own WP-Cron.

## Test

```bash
pytest wp-cron-disabled-emails-never-send/python
node --test wp-cron-disabled-emails-never-send/node
```
