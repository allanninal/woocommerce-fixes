# Cannot reactivate a pending-cancel sub

A WooCommerce Subscription in pending-cancel status keeps a scheduled end date on it, the date the subscription will fully cancel at the end of the term the customer already paid for. Clicking Reactivate in wp-admin, or sending a plain status update through the REST API, gets rejected because that leftover end date blocks the direct jump back to active. This script clears the scheduled end date, confirms the customer's saved Stripe payment method still works, and only then sets the subscription back to active, in the same order a support agent would do it by hand.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/cannot-reactivate-a-pending-cancel-sub/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export SUBSCRIPTION_ID="1234"
export DRY_RUN="true"   # start safe, change to false to write

python cannot-reactivate-a-pending-cancel-sub/python/reactivate_pending_cancel.py
node   cannot-reactivate-a-pending-cancel-sub/node/reactivate-pending-cancel.js
```

`decide` is a pure function: it only returns `repair` when the subscription is stuck on pending-cancel, a saved PaymentIntent exists on the last order, and Stripe still reports that payment method as usable. Anything else comes back `blocked` so a human can look at it. Start with `DRY_RUN=true` to see what the script would do before it writes anything.

## Test

```bash
pytest cannot-reactivate-a-pending-cancel-sub/python
node --test cannot-reactivate-a-pending-cancel-sub/node
```
