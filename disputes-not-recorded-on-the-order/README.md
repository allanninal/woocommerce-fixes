# Disputes not recorded on the order

A chargeback pulls funds out of your Stripe balance the moment the bank files it, but nothing about that event reaches WooCommerce on its own unless the `charge.dispute.*` webhooks are wired up and processed. When they are missed, the order still shows its normal paid total, the shop manager has no idea money left the account, and the evidence deadline can pass unnoticed. This job walks recent disputes from Stripe, finds the order that was charged, and writes the dispute status, amount, and evidence deadline onto the order as a note and an order meta field, so the loss and the deadline are visible where the shop manager already works.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/disputes-not-recorded-on-the-order/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_HOURS="72"
export HOLD_ON_OPEN_DISPUTE="false"   # true also moves open disputes to on-hold
export DRY_RUN="true"

python disputes-not-recorded-on-the-order/python/record_disputes.py
node   disputes-not-recorded-on-the-order/node/record-disputes.js
```

`decide` is a pure function: an order is recorded only when the dispute's status has never been saved on it, or has moved on since the last run. It is read only by default (it just adds a note and a meta field). Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest disputes-not-recorded-on-the-order/python
node --test disputes-not-recorded-on-the-order/node
```
