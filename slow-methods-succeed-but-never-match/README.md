# Slow methods succeed but never match

SOFORT, Klarna, and other delayed notification payment methods do not confirm at checkout the way a card does. The order is created as Pending on purpose, and the real confirmation can land minutes or hours later from a bank or a lender. If the follow up webhook for that late confirmation is missed, the PaymentIntent quietly moves to `succeeded` on Stripe while the WooCommerce order never catches up. This job lists recently succeeded PaymentIntents from delayed methods, matches each one to its order by metadata or by the order's saved `_stripe_intent_id`, and moves any order still stuck on Pending to Processing once the amount and currency match.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/slow-methods-succeed-but-never-match/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_HOURS="72"
export DRY_RUN="true"   # start safe, change to false to write

python slow-methods-succeed-but-never-match/python/match_delayed_payments.py
node   slow-methods-succeed-but-never-match/node/match-delayed-payments.js
```

`decide` is a pure function: an order is only fixed when the PaymentIntent is `succeeded`, the order is not already paid or closed, and the amount and currency match. It is safe to run again and again. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest slow-methods-succeed-but-never-match/python
node --test slow-methods-succeed-but-never-match/node
```
