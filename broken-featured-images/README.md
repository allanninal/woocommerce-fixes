# Broken featured images

A product can end up with a featured image that 404s: the media file was deleted from the uploads folder, lost in a migration, or never finished uploading. WooCommerce still stores the attachment id on the product, so the storefront, the cart, and the order emails for real paid orders all render a broken image icon instead of the product photo. This job walks products that appear on recent paid orders (verified against Stripe so it only touches products real customers actually bought), checks whether each product's featured image URL resolves, and clears the image reference on any product whose file is missing so WooCommerce falls back to the placeholder image instead of a broken icon.

**Full guide:** https://www.allanninal.dev/woocommerce/broken-featured-images/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export WOO_STORE_URL="https://yourstore.com"
export WOO_CONSUMER_KEY="ck_..."
export WOO_CONSUMER_SECRET="cs_..."
export LOOKBACK_HOURS="24"
export DRY_RUN="true"   # start safe, change to false to write

python broken-featured-images/python/repair_broken_images.py
node   broken-featured-images/node/repair-broken-images.js
```

## Test

```bash
pytest broken-featured-images/python
node --test broken-featured-images/node
```
