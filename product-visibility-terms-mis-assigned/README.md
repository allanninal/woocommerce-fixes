# Product visibility terms mis-assigned

WooCommerce decides what a shopper can see using a hidden taxonomy called `product_visibility`, built from terms like `exclude-from-search`, `exclude-from-catalog`, `featured`, and `outofstock`, not the plain `catalog_visibility`, `featured`, and `stock_status` fields you see in the admin. Those terms are only recomputed when a product goes through WooCommerce's normal save routine, so an import, a bulk edit tool, or a direct database write can leave the fields correct while the terms are stale, causing products to hide or show wrongly. This job walks every product through the WooCommerce REST API, recomputes the exact term set the product's own fields imply, compares it to what is currently assigned, and repairs any mismatch by re-saving the product's own fields so WooCommerce rebuilds the terms.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/product-visibility-terms-mis-assigned/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export DRY_RUN="true"   # start safe, change to false to write

python product-visibility-terms-mis-assigned/python/repair_visibility_terms.py
node   product-visibility-terms-mis-assigned/node/repair-visibility-terms.js
```

`decide` is a pure function: a product is only flagged for repair when the `product_visibility` term set computed from its own `catalog_visibility`, `featured`, and `stock_status` fields does not match the terms currently assigned. It never writes taxonomy terms directly, it only re-saves the product's own fields through the REST API, which forces WooCommerce's save routine to rebuild the terms. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest product-visibility-terms-mis-assigned/python
node --test product-visibility-terms-mis-assigned/node
```
