# Push a card change to Stripe

A shopper updates their card on a WooCommerce order, or through My Account, Change payment method, and the new card is charged just fine on that one order. But the Stripe customer record is never told the card changed, so `invoice_settings.default_payment_method` still points at the old card. The next Stripe Billing renewal, or the next off-session charge, reaches for the old card and fails. This job walks recent paid orders, reads the PaymentIntent saved on each one, and pushes its payment method onto the Stripe customer as the new default whenever it differs from what Stripe already has on file.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/push-a-card-change-to-stripe/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"

python push-a-card-change-to-stripe/python/push_card_to_stripe.py
node   push-a-card-change-to-stripe/node/push-card-to-stripe.js
```

`decide` is a pure function: an order is pushed only when it is paid, its PaymentIntent succeeded with the right amount, and the payment method on that intent does not match the Stripe customer's current default. It skips anything already in sync and reports orders it cannot safely act on. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest push-a-card-change-to-stripe/python
node --test push-a-card-change-to-stripe/node
```
