# Duplicate customers for one email

A shopper can end up with several Stripe Customer objects tied to the same email: one made at guest checkout, one made when they later created an account, one made by a retried checkout after a timeout. Each Customer keeps its own saved cards and its own history, so "My account" shows no saved card, support cannot see the full order history in one place, and a saved card on an old customer can no longer be charged for a subscription renewal. This job groups the matching Stripe customers by email, picks one survivor per email, moves every saved payment method onto the survivor, and repoints the WooCommerce user's `_stripe_customer_id` meta back to it. Duplicates are never deleted, only detached, so nothing is destroyed.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/duplicate-customers-for-one-email/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"

python duplicate-customers-for-one-email/python/merge_duplicate_customers.py
node   duplicate-customers-for-one-email/node/merge-duplicate-customers.js
```

`decide` and `pick_survivor` (`pickSurvivor` in Node) are pure functions: given every Stripe customer for one email, they pick a survivor (an active subscription wins, then the most orders, then the oldest customer on a tie) and list the rest as duplicates to fold in. They touch no network, so they are safe to unit test. It is read only by default. Start with `DRY_RUN=true` to review the merge plan before it writes.

## Test

```bash
pytest duplicate-customers-for-one-email/python
node --test duplicate-customers-for-one-email/node/*.test.js
```
