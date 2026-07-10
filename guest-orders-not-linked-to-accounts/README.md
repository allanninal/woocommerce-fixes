# Guest orders not linked to accounts

A guest checkout never sets `customer_id` on the order, even when the billing email matches a real, registered customer. The order sits at `customer_id` 0 forever, so it never shows up under "My account", loyalty and reward plugins never see it, and any per-customer report undercounts that shopper. This job walks recent guest orders, looks up a customer by billing email through the WooCommerce REST API, and confirms the order was really paid by checking the saved Stripe PaymentIntent before relinking it to that account.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/guest-orders-not-linked-to-accounts/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export REQUIRE_PAID="true"   # confirm a matching succeeded Stripe charge before linking
export DRY_RUN="true"

python guest-orders-not-linked-to-accounts/python/link_guest_orders.py
node   guest-orders-not-linked-to-accounts/node/link-guest-orders.js
```

`decide` is a pure function: an unlinked order is only linked when exactly one account uses the billing email and, unless `REQUIRE_PAID` is turned off, Stripe confirms a matching succeeded charge. Orders with no match, more than one match, or an unpaid or mismatched charge are left alone and logged. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest guest-orders-not-linked-to-accounts/python
node --test guest-orders-not-linked-to-accounts/node
```
