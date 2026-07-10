# Import cards from another processor

After a switch to Stripe, every card saved on the old processor is a token that Stripe cannot read, so checkout and subscription renewals fail even though the physical cards are fine. This script does not move card numbers. It reads the mapping file your old processor and Stripe produced during a supported card migration (old customer id to new Stripe PaymentMethod id), attaches each migrated PaymentMethod to a Stripe Customer, and saves the new ids on the matching WooCommerce customer so renewals keep working.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/import-cards-from-another-processor/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export MAPPING_FILE="migration_mapping.csv"
export DRY_RUN="true"

python import-cards-from-another-processor/python/import_migrated_cards.py
node   import-cards-from-another-processor/node/import-migrated-cards.js
```

`decide` is a pure function: a customer is linked only when a WooCommerce customer matches the mapping row, the row has a real Stripe PaymentMethod id (a `pm_...` id), and the customer is not already linked. It writes nothing by default. Start with `DRY_RUN=true` to review the plan first.

## Test

```bash
pytest import-cards-from-another-processor/python
node --test import-cards-from-another-processor/node
```
