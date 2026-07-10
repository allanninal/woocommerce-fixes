# Out of stock but still purchasable

A product can end up with stock_status = "outofstock" while purchasable stays true and catalog_visibility still lists it in the shop, so the buy button keeps working after the last unit sells. This usually happens on variable products, where a variation sells out but the parent's stock_status never resyncs, or a stock import writes the quantity but not the status. This job walks the catalog, locks down any product or variation that is out of stock but still purchasable or still fully listed, then cross checks recent open orders against Stripe (using the saved PaymentIntent id from order meta `_stripe_intent_id` or `transaction_id`) to flag any order that slipped through and was actually charged while the item was broken.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/out-of-stock-but-still-purchasable/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_DAYS="7"
export DRY_RUN="true"

python out-of-stock-but-still-purchasable/python/fix_purchasable_stock.py
node   out-of-stock-but-still-purchasable/node/fix-purchasable-stock.js
```

`decideProduct` (or `decide_product` in Python) is a pure function: a product is repaired only when it is out of stock and still purchasable or still fully listed. `decideOrder` (or `decide_order`) is a second pure function that only flags an open order touching a repaired product, and tells you whether Stripe shows a real charge, so a human can decide to fulfil from backorder or refund. It never cancels or refunds automatically. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest out-of-stock-but-still-purchasable/python
node --test out-of-stock-but-still-purchasable/node
```
