# REST pagination breaks on large sets

Walking WooCommerce orders with page= and per_page= alone is unsafe once a store has a large, changing order table: the default sort is by date, dates are not unique, and a row can slide from one page to another between two requests, so it never shows up in either page you fetched. This job walks orders with a stable sort (orderby=id&order=asc) and an id floor instead of a page number, so nothing between two ids can be skipped or lost. It then cross-checks each order's saved Stripe PaymentIntent and repairs anything Stripe already settled that the pagination bug left unpaid.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/rest-pagination-breaks-on-large-sets/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export PAGE_SIZE="100"
export DRY_RUN="true"   # start safe, change to false to write

python rest-pagination-breaks-on-large-sets/python/paginate_orders.py
node   rest-pagination-breaks-on-large-sets/node/paginate-orders.js
```

`decideBatch` (the stable-sort walk) and `decide` (the repair rule) are both pure functions: no network, no Stripe account needed to test them. An order is only repaired when it is unpaid in WooCommerce while Stripe confirms a matching succeeded PaymentIntent. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest rest-pagination-breaks-on-large-sets/python
node --test rest-pagination-breaks-on-large-sets/node
```
