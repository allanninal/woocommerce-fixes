# Stale reserved-stock rows oversell

WooCommerce holds stock for an order the moment checkout starts, before payment is confirmed. That hold is meant to expire on its own, but a crashed checkout, a timed out payment page, or a queue worker that never ran can leave the order on pending or checkout-draft long after the hold window passed. The reservation is now stale: the item still counts as sold, even though no payment ever completed, so a second buyer can be oversold the same units. This job walks recent unpaid orders, checks each one's age and its Stripe PaymentIntent, and cancels the order (which releases the stock hold) only when the hold is expired and Stripe confirms no payment ever came through.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/stale-reserved-stock-rows-oversell/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export HOLD_MINUTES="60"
export DRY_RUN="true"

python stale-reserved-stock-rows-oversell/python/release_stale_reservations.py
node   stale-reserved-stock-rows-oversell/node/release-stale-reservations.js
```

`decide` is a pure function: an order is only released when it is still in a stock-holding status (pending or checkout-draft), the hold window has passed, and Stripe has no matching succeeded PaymentIntent. Anything Stripe shows as paid is left alone. Start with `DRY_RUN=true` to review the list before it cancels anything.

## Test

```bash
pytest stale-reserved-stock-rows-oversell/python
node --test stale-reserved-stock-rows-oversell/node
```
