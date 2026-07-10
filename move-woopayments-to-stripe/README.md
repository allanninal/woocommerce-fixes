# Move WooPayments to Stripe

When a store moves off WooPayments to its own direct Stripe account, Stripe's account migration tool copies each saved PaymentMethod to the new account and keeps the same `pm_...` id. WooCommerce does not know this happened, so saved tokens and subscriptions still point at the old WooPayments gateway. This script confirms each PaymentMethod is really present on the new Stripe account, then repoints the WooCommerce token to the direct `stripe` gateway, so renewals keep working on the card the buyer already saved, with no new checkout and no re-asking the buyer for their card.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/move-woopayments-to-stripe/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python move-woopayments-to-stripe/python/migrate_woopayments_tokens.py
node   move-woopayments-to-stripe/node/migrate-woopayments-tokens.js
```

`decide` is a pure function: a token is only repointed once the matching PaymentMethod is confirmed attached on the new Stripe account. Tokens still on WooPayments whose PaymentMethod is not yet found there are left alone and logged, never guessed at. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest move-woopayments-to-stripe/python
node --test move-woopayments-to-stripe/node
```
