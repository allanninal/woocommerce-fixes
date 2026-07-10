"""Clear stale WooCommerce persistent cart meta from wp_usermeta.

WooCommerce saves a logged in customer's cart to user meta
(_woocommerce_persistent_cart_<blog_id>) on every cart change so it survives
across sessions and devices. Nothing in core ever clears that meta once the
cart is abandoned or the customer stops shopping, so wp_usermeta grows
without bound over the life of a store. This walks customers through the
WooCommerce REST API, finds carts that still hold real items, and clears the
meta for any customer who has gone quiet past a threshold. Safe by default
(DRY_RUN). Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/persistent-cart-data-never-cleared/
"""
import os
import logging
from datetime import datetime, timezone
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_stale_carts")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
STALE_DAYS = int(os.environ.get("STALE_DAYS", "180"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CART_META_PREFIX = "_woocommerce_persistent_cart_"


def customers():
    """Page through every WooCommerce customer."""
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/customers",
            params={"per_page": 50, "page": page, "orderby": "registered_date"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for customer in batch:
            yield customer
        page += 1


def cart_meta_of(customer):
    """The persistent cart meta entry on a customer, or None if not set."""
    for meta in customer.get("meta_data") or []:
        if str(meta.get("key", "")).startswith(CART_META_PREFIX):
            return meta
    return None


def last_activity(customer):
    """ISO date of the customer's most recent order, or their registration date."""
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"customer": customer["id"], "per_page": 1, "orderby": "date", "order": "desc"},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    orders = r.json()
    if orders:
        return orders[0]["date_created"]
    return customer.get("date_created")


def days_since(iso_date):
    """Whole days between now and an ISO 8601 date, or None if there is no date."""
    if not iso_date:
        return None
    dt = datetime.fromisoformat(iso_date.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - dt).days


def cart_has_items(cart_meta):
    """True when the persistent cart meta value actually holds line items."""
    value = (cart_meta or {}).get("value")
    if not value or not isinstance(value, dict):
        return False
    cart = value.get("cart")
    return bool(cart)


def decide(cart_meta, days_quiet, stale_days):
    """Pure decision function: no I/O, safe to unit test.

    Returns a (action, reason) tuple where action is one of
    "skip" or "clear".
    """
    if cart_meta is None:
        return ("skip", "no persistent cart meta")
    if not cart_has_items(cart_meta):
        return ("skip", "cart meta is empty")
    if days_quiet is None or days_quiet < stale_days:
        return ("skip", "customer has not been quiet long enough")
    return ("clear", f"quiet for {days_quiet} days, past the {stale_days} day threshold")


def clear_cart(customer_id, meta_key):
    """Set the persistent cart meta value to empty, the same shape a real checkout leaves."""
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}",
        json={"meta_data": [{"key": meta_key, "value": ""}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    cleared = 0
    for customer in customers():
        cart_meta = cart_meta_of(customer)
        days_quiet = days_since(last_activity(customer)) if cart_meta else None
        action, reason = decide(cart_meta, days_quiet, STALE_DAYS)
        if action == "skip":
            continue
        log.info("Customer %s: %s. %s", customer["id"], reason, "would clear" if DRY_RUN else "clearing")
        if not DRY_RUN:
            clear_cart(customer["id"], cart_meta["key"])
        cleared += 1
    log.info("Done. %d customer(s) %s.", cleared, "to clear" if DRY_RUN else "cleared")


if __name__ == "__main__":
    run()
