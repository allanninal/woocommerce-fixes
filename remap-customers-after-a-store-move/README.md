# Remap customers after a store move

A store migration usually re-creates WordPress user accounts with new IDs, but every WooCommerce order keeps its old numeric `customer_id`. That number now points at the wrong account, or at nobody. This script walks every order, finds the WordPress user whose email matches the order's billing email, cross checks that user's Stripe customer id against the order's Stripe customer id, and only remaps the order when both signals agree on exactly one account. Anything ambiguous, orphaned, or contradictory is reported for manual review instead of guessed at.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/remap-customers-after-a-store-move/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # true reports the plan only, false writes the remap

python remap-customers-after-a-store-move/python/remap_customers.py
node   remap-customers-after-a-store-move/node/remap-customers.js
```

`decide` is a pure function: an order is only remapped when its current customer_id does not resolve to a real account and exactly one WordPress user matches its billing email. Orphaned emails and email addresses shared by more than one account are reported, not touched. `stripe_ids_agree` / `stripeIdsAgree` adds a second check so an email match that contradicts the order's Stripe customer id is treated the same as ambiguous. Start with `DRY_RUN=true` to review the full report before it writes.

## Test

```bash
pytest remap-customers-after-a-store-move/python
node --test remap-customers-after-a-store-move/node
```
