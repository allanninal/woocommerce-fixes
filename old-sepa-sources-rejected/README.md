# Old SEPA sources rejected

Stripe stopped accepting old `src_...` Sources for off-session SEPA Direct Debit renewals, but many WooCommerce Subscriptions saved before the switch to SEPA Debit PaymentMethods never got upgraded. When a renewal fires against one of these legacy Sources, Stripe rejects the charge and the order fails or goes on-hold. This job walks recent renewal orders, finds the ones still pointing at a legacy Source, and checks the Stripe Customer for a newer SEPA Debit PaymentMethod. When one exists it relinks the order and subscription to it; when none exists it flags the order so the shopper can re-enter their IBAN. Read only unless `DRY_RUN=false`.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/old-sepa-sources-rejected/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export DRY_RUN="true"   # start safe, change to false to write

python old-sepa-sources-rejected/python/migrate_sepa_sources.py
node   old-sepa-sources-rejected/node/migrate-sepa-sources.js
```

`decide` is a pure function: an order is only migrated or flagged when it is awaiting or retrying a renewal and its saved token is a legacy `src_...` Source. It migrates when a SEPA Debit PaymentMethod is already on the Stripe Customer, and flags for the shopper otherwise. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest old-sepa-sources-rejected/python
node --test old-sepa-sources-rejected/node/*.test.js
```
