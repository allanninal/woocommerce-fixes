# Bulk swap a reissued card range

An issuer or bank reissues a whole range of cards after a breach, and every subscription still charging one of the old numbers is about to fail its next renewal. This job walks active, on-hold, and pending WooCommerce Subscriptions, finds the ones still storing an old, reissued Stripe `payment_method` id, and swaps each one onto the customer's current default payment method, but only when that replacement is real, different, and not itself on the reissued range. Anything without a safe replacement gets flagged with a note instead of guessed at.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/bulk-swap-a-reissued-card-range/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export AFFECTED_PAYMENT_METHOD_IDS="pm_old_1,pm_old_2,pm_old_3"
export DRY_RUN="true"   # start safe, change to false to write

python bulk-swap-a-reissued-card-range/python/swap_reissued_card.py
node   bulk-swap-a-reissued-card-range/node/swap-reissued-card.js
```

`decide` is a pure function: a subscription is swapped only when it is active, its stored token is on the reissued range, and the customer has a current default payment method that is different and clean. Anything else is skipped or flagged for manual follow up. Start with `DRY_RUN=true` to review the plan first.

## Test

```bash
pytest bulk-swap-a-reissued-card-range/python
node --test bulk-swap-a-reissued-card-range/node
```
