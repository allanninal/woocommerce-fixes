"""Revert WooCommerce sale prices whose sale window already ended.

An order can end up looking fine while the catalog quietly stays wrong: a
scheduled sale finishes on paper, but the wc_scheduled_sales WP-Cron task that
should clear it never runs (WP-Cron disabled, no overnight traffic, a
migration, a plugin conflict). This walks every product WooCommerce currently
flags as on sale, compares its stored sale end date to now, and clears the
sale price (and turns off the sale dates) for any product whose sale window
has passed. Regular price is never touched. Safe by default. Run on a
schedule.

Guide: https://www.allanninal.dev/woocommerce/expired-sale-prices-never-revert/
"""
import os
import logging
from datetime import datetime, timezone
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("revert_expired_sales")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def parse_gmt(value):
    """Parse a WooCommerce *_gmt date string (naive, UTC) into an aware datetime."""
    if not value:
        return None
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def sale_window_of(product):
    """Pull the fields that matter for the decision out of a product payload."""
    return {
        "sale_price": product.get("sale_price") or "",
        "regular_price": product.get("regular_price") or "",
        "ends_at": parse_gmt(product.get("date_on_sale_to_gmt")),
    }


def decide(sale_window, now):
    """Pure decision: should this product's sale price be reverted right now?

    No I/O here on purpose, so this can be unit tested without a live store.
    """
    if not sale_window["sale_price"]:
        return ("skip", "no sale price set")
    if sale_window["ends_at"] is None:
        return ("skip", "open-ended sale, no end date")
    if sale_window["ends_at"] > now:
        return ("skip", "sale window still open")
    return ("revert", "sale end date has passed")


def products_on_sale():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products",
            params={"on_sale": "true", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for product in batch:
            yield product
        page += 1


def revert_sale(product_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json={"sale_price": "", "date_on_sale_from": None, "date_on_sale_to": None},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    now = datetime.now(timezone.utc)
    reverted = 0
    for product in products_on_sale():
        window = sale_window_of(product)
        action, reason = decide(window, now)
        if action != "revert":
            continue
        log.info(
            "Product %s: %s. %s",
            product["id"], reason, "would revert" if DRY_RUN else "reverting",
        )
        if not DRY_RUN:
            revert_sale(product["id"])
        reverted += 1
    log.info("Done. %d product(s) %s.", reverted, "to revert" if DRY_RUN else "reverted")


if __name__ == "__main__":
    run()
