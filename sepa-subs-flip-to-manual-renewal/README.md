# SEPA subs flip to manual renewal

An update to WooCommerce Subscriptions or the Stripe gateway can change how the store checks for a saved SEPA Direct Debit token, since that mandate attaches to the customer a moment after the first payment rather than instantly. When the check misses that delayed attachment, the plugin sets `requires_manual_renewal` even though the mandate is still active in Stripe. This job walks active subscriptions on manual renewal, checks Stripe for a real attached and enabled SEPA PaymentMethod on the customer, and restores automatic renewal for the ones that have one. It never triggers a charge, it only fixes the renewal setting and the saved token.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/sepa-subs-flip-to-manual-renewal/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python sepa-subs-flip-to-manual-renewal/python/restore_sepa_renewal.py
node   sepa-subs-flip-to-manual-renewal/node/restore-sepa-renewal.js
```

`decide` is a pure function: a subscription is repaired only when it is active, currently on manual renewal, and Stripe shows an attached, non-disabled SEPA Direct Debit PaymentMethod on the customer. Everything else is skipped or held for manual review. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest sepa-subs-flip-to-manual-renewal/python
node --test sepa-subs-flip-to-manual-renewal/node
```
