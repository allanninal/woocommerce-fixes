# Legacy order rows survive after HPOS cleanup

Turning on High-Performance Order Storage moves every order into WooCommerce's new custom tables, and once compatibility mode is off the matching legacy `shop_order` post row in `wp_posts` is supposed to be removed. That cleanup step can be interrupted, skipped for a subset of orders, or never run at all, leaving old rows behind. This job walks HPOS orders through the REST API, reads the legacy post id each order remembers, and cross-checks Stripe to confirm the order is fully settled before reporting the legacy row as a safe cleanup candidate. It never deletes anything itself.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/legacy-order-rows-survive-after-hpos-cleanup/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="90"
export DRY_RUN="true"

python legacy-order-rows-survive-after-hpos-cleanup/python/find_legacy_order_rows.py
node   legacy-order-rows-survive-after-hpos-cleanup/node/find-legacy-order-rows.js
```

`decide` is a pure function: a legacy row is only reported when the order has a saved legacy post id, that post still exists, the order is no longer open, and Stripe confirms the payment settled with a matching amount. Start with `DRY_RUN=true` to review the list before anything writes an order note.

## Test

```bash
pytest legacy-order-rows-survive-after-hpos-cleanup/python
node --test legacy-order-rows-survive-after-hpos-cleanup/node
```
