# Orphaned postmeta rows

A WooCommerce order keeps its Stripe link in postmeta, in the key `_stripe_intent_id`, or in the `transaction_id` column when the plugin writes it there instead. When an order is deleted straight from `wp_posts` (a manual cleanup script, a bad SQL `DELETE`, a plugin that skips `wp_delete_post`'s meta cleanup) the postmeta row can survive with nothing left to attach to. This job walks recent Stripe PaymentIntents, since Stripe is the durable record that an order used to exist, and checks the WooCommerce REST API to see whether the order it points to is still there. Anything missing is reported as an orphan candidate so the database cleanup step is safe to run. Read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/orphaned-postmeta-rows/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="90"
export DRY_RUN="true"

python orphaned-postmeta-rows/python/find_orphaned_postmeta.py
node   orphaned-postmeta-rows/node/find-orphaned-postmeta.js
```

`decide` is a pure function: an intent is reported as an orphan only when its `metadata.order_id` points to an order the WooCommerce REST API can no longer find. It is read only, it never deletes a row itself. Start with `DRY_RUN=true` to review the list before you run any cleanup SQL.

## Test

```bash
pytest orphaned-postmeta-rows/python
node --test orphaned-postmeta-rows/node
```
