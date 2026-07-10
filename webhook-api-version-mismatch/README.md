# Webhook API version mismatch

Stripe removed the `charges` array from the PaymentIntent object on newer API versions and replaced it with `latest_charge`. A webhook handler or script still written for the old shape reads an empty `charges` list, decides the payment has no charge yet, and skips the order, so the order never gets a transaction id and can sit unpaid even though Stripe already shows a succeeded charge. This job walks recent orders that have a saved PaymentIntent id but no transaction id, reads the intent from Stripe, resolves the charge id from whichever field is present, and writes it back onto the order with a note.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/webhook-api-version-mismatch/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"   # start safe, change to false to write

python webhook-api-version-mismatch/python/resolve_charge_id.py
node   webhook-api-version-mismatch/node/resolve-charge-id.js
```

`decide` is a pure function: an order is only repaired when it has a saved PaymentIntent id, no transaction id yet, and Stripe shows the PaymentIntent as succeeded with a charge id on either the new `latest_charge` field or the legacy `charges` list, and the amount matches. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest webhook-api-version-mismatch/python
node --test webhook-api-version-mismatch/node
```
