# Clear transients tool leaves residue

WooCommerce Status, Tools, Clear transients deletes the `_transient_wc_*` and `_transient_timeout_wc_*` rows in `wp_options` in one pass, but the two rows are separate database writes. If the request is cut short, one row can survive without its partner, and WooCommerce's own cache functions skip a row with no timeout, so it never refreshes again. The visible symptom is a cached Stripe PaymentIntent status on an order that stops following the real payment. This job walks recent orders, reads the saved PaymentIntent id, and flags or repairs any order whose cached state disagrees with what Stripe reports right now. Safe by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/clear-transients-tool-leaves-residue/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"

python clear-transients-tool-leaves-residue/python/repair_transient_residue.py
node   clear-transients-tool-leaves-residue/node/repair-transient-residue.js
```

`decide` is a pure function: an order is repaired only when Stripe's current PaymentIntent status disagrees with the order's own status, and it is skipped whenever the amount does not match, since that needs a human look. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest clear-transients-tool-leaves-residue/python
node --test clear-transients-tool-leaves-residue/node
```
