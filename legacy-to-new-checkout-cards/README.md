# Legacy to new checkout cards

A card saved through the old Stripe checkout can look perfectly fine in "My account" and still fail the moment a store switches to the new checkout (Payment Element, SCA-ready, backed by `PaymentMethod` objects attached to a Stripe Customer). This job reads every customer's saved WooCommerce payment tokens, checks the matching object on Stripe, and drops any token the new checkout cannot safely reuse (a legacy Source or Card id, or a PaymentMethod that is not attached to a Stripe Customer) so the shopper is prompted to re-enter their card instead of hitting a silent decline on their next order.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/legacy-to-new-checkout-cards/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python legacy-to-new-checkout-cards/python/repair_legacy_tokens.py
node   legacy-to-new-checkout-cards/node/repair-legacy-tokens.js
```

`decide` is a pure function: a token is dropped only when it is a legacy Source or Card id the new checkout cannot reuse, or a PaymentMethod that Stripe no longer knows about or that is not attached to a Stripe Customer. Everything else is kept or skipped. Start with `DRY_RUN=true` to review the list before it removes anything.

## Test

```bash
pytest legacy-to-new-checkout-cards/python
node --test legacy-to-new-checkout-cards/node/repair-legacy-tokens.test.js
```
