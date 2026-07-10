"""Create the missing Stripe Product and Price for WooCommerce products that are
billed through Stripe (usually WooCommerce Subscriptions) but have never been synced.

A subscription product can be sold in WooCommerce for months before anyone notices
that Stripe has no matching Product or Price behind it, usually because it was
imported, duplicated, or created before the store gateway was switched on. This
walks WooCommerce products, checks the saved Stripe ids in product meta, and
creates whatever Stripe is missing, then writes the new ids back onto the product.
Read only by default until DRY_RUN is turned off. Safe to run again and again.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync_products_to_stripe")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DEFAULT_CURRENCY = os.environ.get("DEFAULT_CURRENCY", "usd")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

SYNCABLE_STATUSES = {"publish"}
SYNCABLE_TYPES = {"simple", "subscription", "variable-subscription"}


def stripe_ids_of(product):
    """The saved Stripe Product and Price ids from WooCommerce product meta."""
    product_id = None
    price_id = None
    for meta in product.get("meta_data") or []:
        if meta.get("key") == "_stripe_product_id" and meta.get("value"):
            product_id = meta["value"]
        if meta.get("key") == "_stripe_price_id" and meta.get("value"):
            price_id = meta["value"]
    return product_id, price_id


def product_amount_minor(product):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since price * 100 is wrong for those.
    price = product.get("price") or product.get("regular_price") or "0"
    return round(float(price) * 100)


def decide(product, stripe_product, stripe_price):
    """Pure decision: what does this WooCommerce product need in Stripe?

    Returns a tuple of (action, reason). Action is one of:
      "skip"          - not something we sync (draft, unpriced, wrong type)
      "create_both"   - no Stripe product or price exists yet, make both
      "create_price"  - the Stripe product exists but the price is missing or stale
      "ok"             - already in sync, nothing to do
    """
    if product.get("status") not in SYNCABLE_STATUSES:
        return ("skip", "product is not published")
    if product.get("type") not in SYNCABLE_TYPES:
        return ("skip", "product type is not billed through Stripe")
    if product_amount_minor(product) <= 0:
        return ("skip", "product has no price yet")

    if stripe_product is None:
        return ("create_both", "no Stripe product exists for this WooCommerce product")

    if stripe_product.get("active") is False:
        return ("create_both", "the saved Stripe product was archived")

    if stripe_price is None:
        return ("create_price", "Stripe product exists but the price is missing")

    if stripe_price.get("active") is False:
        return ("create_price", "the saved Stripe price was archived")

    if stripe_price.get("unit_amount") != product_amount_minor(product):
        return ("create_price", "WooCommerce price changed since the last sync")

    return ("ok", "already in sync")


def get_stripe_product(product_id):
    if not product_id:
        return None
    try:
        return stripe.Product.retrieve(product_id)
    except stripe.error.InvalidRequestError:
        return None


def get_stripe_price(price_id):
    if not price_id:
        return None
    try:
        return stripe.Price.retrieve(price_id)
    except stripe.error.InvalidRequestError:
        return None


def woo_products():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products",
            params={"status": "publish", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for product in batch:
            yield product
        page += 1


def save_stripe_ids(product_id, stripe_product_id, stripe_price_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json={"meta_data": [
            {"key": "_stripe_product_id", "value": stripe_product_id},
            {"key": "_stripe_price_id", "value": stripe_price_id},
        ]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def create_stripe_product_and_price(product):
    stripe_product = stripe.Product.create(
        name=product["name"],
        metadata={"woo_product_id": str(product["id"])},
    )
    stripe_price = stripe.Price.create(
        product=stripe_product["id"],
        unit_amount=product_amount_minor(product),
        currency=DEFAULT_CURRENCY,
    )
    return stripe_product, stripe_price


def create_stripe_price(stripe_product_id, product):
    return stripe.Price.create(
        product=stripe_product_id,
        unit_amount=product_amount_minor(product),
        currency=DEFAULT_CURRENCY,
    )


def run():
    synced = 0
    for product in woo_products():
        stripe_product_id, stripe_price_id = stripe_ids_of(product)
        stripe_product = get_stripe_product(stripe_product_id)
        stripe_price = get_stripe_price(stripe_price_id)
        action, reason = decide(product, stripe_product, stripe_price)

        if action == "skip":
            continue
        if action == "ok":
            continue

        log.info(
            "Product %s (%s): %s. %s",
            product["id"], product.get("name"), reason,
            "would sync" if DRY_RUN else "syncing",
        )
        if not DRY_RUN:
            if action == "create_both":
                new_product, new_price = create_stripe_product_and_price(product)
                save_stripe_ids(product["id"], new_product["id"], new_price["id"])
            elif action == "create_price":
                new_price = create_stripe_price(stripe_product["id"], product)
                save_stripe_ids(product["id"], stripe_product["id"], new_price["id"])
        synced += 1
    log.info("Done. %d product(s) %s.", synced, "to sync" if DRY_RUN else "synced")


if __name__ == "__main__":
    run()
