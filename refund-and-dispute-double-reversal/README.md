# Refund and dispute double reversal

A charge can be refunded by the store and later disputed by the buyer's bank. Those are two separate withdrawals in Stripe, so the same sale can end up costing the merchant twice: once through the refund, once through the dispute plus its fee. This job walks recent Stripe disputes, checks each disputed charge's refund history, and reports every case where money left the account twice, adding a WooCommerce order note with the estimated extra loss in cents so finance can see it without digging through the Stripe dashboard.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/refund-and-dispute-double-reversal/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="30"
export DEFAULT_DISPUTE_FEE_CENTS="1500"
export DRY_RUN="true"

python refund-and-dispute-double-reversal/python/refund_dispute_double_reversal.py
node   refund-and-dispute-double-reversal/node/refund-dispute-double-reversal.js
```

`decide` is a pure function: given the disputed amount and the amount already refunded on that charge before the dispute, both in minor units (cents), it returns whether this is a double reversal and how much extra was lost. It never changes order status and never touches Stripe money, it only reports and, once dry run is off, adds an order note. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest refund-and-dispute-double-reversal/python
node --test refund-and-dispute-double-reversal/node
```
