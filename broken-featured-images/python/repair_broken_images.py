"""Find and clear WooCommerce product featured images that point to a missing file.

A product can end up with a featured image that 404s: the media file was deleted from
the uploads folder, lost in a migration, or never finished uploading. WooCommerce still
stores the attachment id on the product, so the storefront, the cart, and the order
emails for real paid orders all render a broken image icon instead of the product photo.

This walks products that appear on recent paid orders (verified against Stripe so we
only touch products real customers actually bought), checks whether each product's
featured image URL resolves, and clears the image reference on any product whose file
is missing. WooCommerce then falls back to the store placeholder image instead of a
broken icon. Read only by default. Run on a schedule.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_broken_images")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(product, image_reachable):
    """Pure decision: should we clear this product's featured image reference?

    product: a dict shaped like the WooCommerce product REST response, at least
        {"id": int, "images": [{"id": int, "src": str}, ...]}
    image_reachable: bool or None. True/False when we checked the URL, None when
        the product has no featured image at all (nothing to do).
    Returns (action, reason) where action is one of "skip", "clear".
    """
    images = product.get("images") or []
    if not images:
        return ("skip", "product has no featured image")
    if image_reachable is None:
        return ("skip", "no reachability result to judge")
    if image_reachable:
        return ("skip", "featured image resolves fine")
    return ("clear", "featured image file is missing (404 or error)")


def order_amount_minor(order):
    return round(float(order["total"]) * 100)


def payment_confirmed(order, intent):
    """True when Stripe confirms this order was really paid the amount on file.

    Used to decide which products are worth checking: only ones bought in orders
    with a real, matching, succeeded Stripe payment behind them.
    """
    if order["status"] not in PAID_STATUSES:
        return False
    if intent is None or intent.get("status") != "succeeded":
        return False
    return abs(order_amount_minor(order) - intent.get("amount_received", 0)) <= 1


def recent_paid_orders(lookback_hours):
    since = time.strftime(
        "%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - lookback_hours * 3600)
    )
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={
                "status": "processing,completed",
                "after": since,
                "per_page": 50,
                "page": page,
            },
            auth=AUTH,
            timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def get_product(product_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/products/{product_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def image_url_reachable(url):
    try:
        r = requests.head(url, timeout=15, allow_redirects=True)
        if r.status_code == 405:
            r = requests.get(url, timeout=15, stream=True)
        return r.status_code < 400
    except requests.RequestException:
        return False


def clear_featured_image(product_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json={"images": []},
        auth=AUTH,
        timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json={},
        auth=AUTH,
        timeout=30,
    )


def run():
    checked_products = {}
    cleared = 0
    for order in recent_paid_orders(LOOKBACK_HOURS):
        intent = get_intent(intent_id_of(order))
        if not payment_confirmed(order, intent):
            continue
        for line_item in order.get("line_items", []):
            product_id = line_item.get("product_id")
            if not product_id or product_id in checked_products:
                continue
            checked_products[product_id] = True
            product = get_product(product_id)
            if product is None:
                log.warning("Product %s from order %s no longer exists", product_id, order["id"])
                continue
            images = product.get("images") or []
            reachable = image_url_reachable(images[0]["src"]) if images else None
            action, reason = decide(product, reachable)
            if action == "skip":
                continue
            log.warning(
                "Product %s: %s. %s", product_id, reason, "would clear" if DRY_RUN else "clearing"
            )
            if not DRY_RUN:
                clear_featured_image(product_id)
            cleared += 1
    log.info("Done. %d product(s) %s.", cleared, "to clear" if DRY_RUN else "cleared")


if __name__ == "__main__":
    run()
