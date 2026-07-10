# Orphaned product variations

A variation is a real "product_variation" post of its own, not just a row inside its
parent. When the parent product is deleted, trashed, or converted from a variable
product back to a simple one, WooCommerce does not always clean up the child
variations first. The orphan keeps its own row in the database and its own entry in
the product lookup table, so it can still surface in stock reports, search, or old
cart and order line items, even though there is no parent left to load it under. This
job checks a list of known variation ids against the WooCommerce REST API and flags
(or trashes) the ones whose parent is gone or is no longer variable.

**Full guide with diagrams:** https://www.allanninal.dev/woocommerce/orphaned-product-variations/

## Run it

```bash
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export CANDIDATE_VARIATION_IDS="501,502,733"
export DRY_RUN="true"   # true reports only, false also trashes the orphans

python orphaned-product-variations/python/find_orphaned_variations.py
node   orphaned-product-variations/node/find-orphaned-variations.js
```

`decide` is a pure function: a variation is only flagged as an orphan when its parent
product record cannot be found, is trashed, or is no longer type `variable`. Start
with `DRY_RUN=true` to review the list before anything is trashed.

## Test

```bash
pytest orphaned-product-variations/python
node --test orphaned-product-variations/node
```
