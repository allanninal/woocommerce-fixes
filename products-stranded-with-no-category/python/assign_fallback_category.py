"""Assign a fallback category to WooCommerce products that have no category at all.

A product with an empty categories array cannot be found through category pages,
menu links, or any widget that filters by category. It still has a direct URL and
still shows in search, so it quietly keeps selling while being invisible everywhere
a browsing shopper would normally find it. This walks published products, flags the
ones with zero categories, and assigns a configured fallback category so the product
is reachable again. It also checks recent Stripe PaymentIntents so a product that is
actively selling gets called out with higher urgency in the log. Read only by
default until DRY_RUN is turned off. Safe to run again and again.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("assign_fallback_category")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
FALLBACK_CATEGORY_ID = int(os.environ.get("FALLBACK_CATEGORY_ID", "0"))
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

SYNCABLE_STATUSES = {"publish"}


def product_id_of(intent):
    """The WooCommerce product id a Stripe PaymentIntent was billed for, if any.

    The WooCommerce Stripe gateway does not put a product id on the PaymentIntent
    itself (it puts the order id there, in metadata.order_id). We read the
    PaymentIntent id from order meta _stripe_intent_id or transaction_id elsewhere
    in this file, so this helper is only used once we already have the order's
    line items in hand.
    """
    return intent.get("metadata", {}).get("order_id")


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def has_category(product):
    return bool(product.get("categories"))


def decide(product, fallback_category_id, recently_sold):
    """Pure decision: does this product need the fallback category assigned?

    Returns a tuple of (action, reason). Action is one of:
      "skip"    - not something we touch (draft/private, or already has a category)
      "blocked" - stranded, but there is no fallback category configured to use
      "fix"     - stranded and needs the fallback category assigned
    `recently_sold` is only used to make the log line more useful; it never
    changes the action itself, since a stranded product needs fixing either way.
    """
    if product.get("status") not in SYNCABLE_STATUSES:
        return ("skip", "product is not published")
    if has_category(product):
        return ("skip", "product already has at least one category")
    if not fallback_category_id:
        return ("blocked", "no FALLBACK_CATEGORY_ID configured")
    if recently_sold:
        return ("fix", "stranded with no category, and it has recent sales")
    return ("fix", "stranded with no category")


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


def recent_succeeded_order_ids():
    """Order ids behind PaymentIntents that succeeded in the lookback window."""
    since = int(time.time()) - LOOKBACK_HOURS * 3600
    order_ids = set()
    for intent in stripe.PaymentIntent.list(limit=100, created={"gte": since}).auto_paging_iter():
        if intent.status == "succeeded":
            order_id = product_id_of(intent)
            if order_id:
                order_ids.add(order_id)
    return order_ids


def recently_sold_product_ids(order_ids):
    """Product ids that appear as a line item on any of the given recent orders."""
    product_ids = set()
    for order_id in order_ids:
        r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
        if r.status_code == 404:
            continue
        r.raise_for_status()
        order = r.json()
        # Confirm the order's own saved PaymentIntent id is the one Stripe reported,
        # so we never trust an order id from metadata alone.
        if not intent_id_of(order):
            continue
        for line in order.get("line_items") or []:
            if line.get("product_id"):
                product_ids.add(line["product_id"])
    return product_ids


def assign_fallback_category(product_id, fallback_category_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json={"categories": [{"id": fallback_category_id}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    blocked = 0
    sold_ids = recently_sold_product_ids(recent_succeeded_order_ids())
    for product in woo_products():
        recently_sold = product["id"] in sold_ids
        action, reason = decide(product, FALLBACK_CATEGORY_ID, recently_sold)
        if action == "skip":
            continue
        if action == "blocked":
            log.warning("Product %s (%s): %s", product["id"], product.get("name"), reason)
            blocked += 1
            continue
        log.info(
            "Product %s (%s): %s. %s",
            product["id"], product.get("name"), reason,
            "would assign fallback category" if DRY_RUN else "assigning fallback category",
        )
        if not DRY_RUN:
            assign_fallback_category(product["id"], FALLBACK_CATEGORY_ID)
        fixed += 1
    log.info(
        "Done. %d product(s) %s. %d blocked on missing config.",
        fixed, "to fix" if DRY_RUN else "fixed", blocked,
    )


if __name__ == "__main__":
    run()
