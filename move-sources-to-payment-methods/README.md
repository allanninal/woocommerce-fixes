# Move sources to payment methods

Stripe is retiring the old Sources API for saved cards, and a legacy `src_...` token cannot carry a shopper through Strong Customer Authentication (SCA) on a later off-session charge. This job walks recent WooCommerce orders, reads the saved Stripe token from order meta `_stripe_intent_id` (falling back to `transaction_id`), and for any legacy card Source still in good standing, wraps it in a new PaymentMethod, attaches it to the Stripe Customer, and re-links the order to the new `pm_...` id. Orders whose Source cannot be safely auto-migrated are flagged instead so the shopper can re-enter their card. Safe by default (`DRY_RUN=true`).

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/move-sources-to-payment-methods/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="60"
export DRY_RUN="true"   # start safe, change to false to write

python move-sources-to-payment-methods/python/migrate_sources_to_pm.py
node   move-sources-to-payment-methods/node/migrate-sources-to-pm.js
```

`decide` is a pure function: an order is only migrated or flagged when its saved token is a legacy `src_...` Source. It migrates when the Source is a `card` type Source still in a `chargeable` or `consumed` state, and flags everything else (missing Source, wrong type, or no longer chargeable). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest move-sources-to-payment-methods/python
node --test move-sources-to-payment-methods/node/*.test.js
```
