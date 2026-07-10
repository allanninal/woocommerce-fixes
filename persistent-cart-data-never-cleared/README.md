# Persistent cart data never cleared

WooCommerce saves a logged in customer's cart to user meta (`_woocommerce_persistent_cart_<blog_id>`) on every cart change so it survives across sessions and devices, but nothing in core ever clears that meta once the cart is abandoned or the customer stops shopping. Over the life of a store this quietly bloats `wp_usermeta` with rows for customers who never came back. This job walks customers through the WooCommerce REST API, finds carts that still hold real items, and clears the meta for any customer who has gone quiet past a configurable threshold.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/persistent-cart-data-never-cleared/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export STALE_DAYS="180"
export DRY_RUN="true"   # start safe, change to false to write

python persistent-cart-data-never-cleared/python/clear_stale_carts.py
node   persistent-cart-data-never-cleared/node/clear-stale-carts.js
```

`decide` is a pure function: a customer's persistent cart is only cleared when the meta holds real line items and the customer has been quiet for at least `STALE_DAYS`. It is safe by default, start with `DRY_RUN=true` to review the list before it writes.

## Test

```bash
pytest persistent-cart-data-never-cleared/python
node --test persistent-cart-data-never-cleared/node
```
