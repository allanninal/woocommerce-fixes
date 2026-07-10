# Deleting a variation does not resync the parent

Deleting a variation removes that row, but nothing tells the parent variable product to recompute its cached price range or stock status. The parent keeps showing the old low price, the old high price, or "In stock" when every remaining variation is out of stock, until something forces a resync. This job walks variable products, reads their live variations from the WooCommerce REST API, works out what the parent's price range and stock status should be, and repairs any parent whose cached values disagree. Read only by default.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/deleting-a-variation-does-not-resync-the-parent/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # start safe, change to false to write

python deleting-a-variation-does-not-resync-the-parent/python/resync_variable_parent.py
node   deleting-a-variation-does-not-resync-the-parent/node/resync-variable-parent.js
```

`decide` is a pure function: a variable product is flagged only when the parent's cached price or stock status disagrees with what its live, purchasable variations say. Start with `DRY_RUN=true` to review the list before it writes anything.

## Test

```bash
pytest deleting-a-variation-does-not-resync-the-parent/python
node --test 'deleting-a-variation-does-not-resync-the-parent/node/*.test.js'
```
