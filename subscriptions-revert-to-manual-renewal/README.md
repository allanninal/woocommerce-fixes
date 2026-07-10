# Subscriptions revert to manual renewal

After a gateway change, an update, or a token migration, active WooCommerce subscriptions can be switched to manual renewal even though they still hold a saved Stripe token. Manual renewal means they stop charging on their own, so they silently lapse. This job finds active subscriptions that require manual renewal but still have a saved token, and turns automatic renewal back on.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/subscriptions-revert-to-manual-renewal/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python subscriptions-revert-to-manual-renewal/python/restore_auto_renewal.py
node   subscriptions-revert-to-manual-renewal/node/restore-auto-renewal.js
```

`is_wrongly_manual` is a pure function: a subscription is flagged only when it is active, set to manual renewal, and still carries a Stripe token (`_stripe_source_id` or `_stripe_customer_id`). It never touches a subscription that is genuinely manual with no token. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest subscriptions-revert-to-manual-renewal/python
node --test subscriptions-revert-to-manual-renewal/node
```
