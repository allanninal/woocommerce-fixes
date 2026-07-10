# Promote the default source

Some Stripe customers still have a legacy Source object set as their default payment, usually because the card was saved years ago before PaymentMethods existed. A Source cannot be confirmed off session under Strong Customer Authentication, so the next subscription renewal fails even though the card itself is fine. This script walks customers behind active or on-hold WooCommerce subscriptions, finds anyone whose Stripe default is still a Source, looks for an attached PaymentMethod with a matching card fingerprint, and promotes it to `invoice_settings.default_payment_method`, the field WooCommerce Subscriptions and Stripe both read before an off session renewal.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/promote-the-default-source/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # true also reports without writing

python promote-the-default-source/python/promote_default_source.py
node   promote-the-default-source/node/promote-default-source.js
```

`decide` is a pure function: a customer is only promoted when their default is a legacy Source and there is an attached PaymentMethod whose card fingerprint matches. Anyone already on a PaymentMethod is skipped, and anyone with no matching PaymentMethod is reported separately rather than touched. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest promote-the-default-source/python
node --test promote-the-default-source/node
```
