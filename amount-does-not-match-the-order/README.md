# Amount does not match the order

A WooCommerce order can be marked paid while its total quietly disagrees with the Stripe PaymentIntent behind it, because of a partial refund applied on only one side, a currency rounding difference, a coupon that changed the order after the PaymentIntent was created, or a manual edit to the order total. This job walks recent paid orders, reads the saved Stripe PaymentIntent id, compares the order total against the amount Stripe actually captured in minor units (cents), and flags any order that drifts by adding an order note (and optionally moving it to on-hold for review).

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/amount-does-not-match-the-order/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export MISMATCH_TOLERANCE_MINOR="1"   # cents of slack before flagging
export REVIEW_HOLD="false"            # true also moves flagged orders to on-hold
export DRY_RUN="true"

python amount-does-not-match-the-order/python/check_amount_mismatch.py
node   amount-does-not-match-the-order/node/check-amount-mismatch.js
```

`decide` is a pure function: an order is flagged only when it is in a paid state, has a succeeded Stripe PaymentIntent attached, and the order total differs from the captured amount by more than the tolerance. It is read only by default (it just adds a note). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest amount-does-not-match-the-order/python
node --test amount-does-not-match-the-order/node
```
