"""Repair WooCommerce variations whose stock_status disagrees with their stock_quantity.

A variation can end up showing "On backorder" in the shop while its stock is at or
below zero and backorders are turned off. WooCommerce only recalculates
stock_status when the quantity changes through its own save path. A CSV import, a
direct database edit, or flipping the backorders setting after the quantity was
already low can leave the stored stock_status stale. This walks the variations of a
product (or every variable product), works out what stock_status should be from the
quantity and the backorders setting, and corrects any variation that disagrees.
Read only by default. Run it by hand or on a schedule.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_variation_stock_status")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
PRODUCT_IDS = [p.strip() for p in os.environ.get("PRODUCT_IDS", "").split(",") if p.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

VALID_STATUSES = {"instock", "outofstock", "onbackorder"}


def expected_stock_status(variation):
    """Work out the stock_status a variation should have.

    Only variations with manage_stock on carry their own quantity, so anything
    else is left to WooCommerce and skipped. Backorders "yes" or "notify" both
    mean the shop should keep selling once stock runs out.
    """
    if not variation.get("manage_stock"):
        return None
    qty = variation.get("stock_quantity")
    if qty is None:
        return None
    backorders = variation.get("backorders", "no")
    if qty > 0:
        return "instock"
    if backorders in ("yes", "notify"):
        return "onbackorder"
    return "outofstock"


def decide(variation):
    """Pure decision: does this variation's stock_status need to change.

    Returns a tuple of (action, reason). action is one of:
      "skip"  - not stock managed, or already correct
      "fix"   - stock_status disagrees with quantity and backorders, repair it
    No I/O happens in here, so it is safe and cheap to unit test.
    """
    expected = expected_stock_status(variation)
    if expected is None:
        return ("skip", "variation does not manage its own stock")
    current = variation.get("stock_status")
    if current not in VALID_STATUSES:
        return ("fix", f"stock_status {current!r} is not a recognized value")
    if current == expected:
        return ("skip", "stock_status already matches quantity and backorders")
    return ("fix", f"stock_status is {current!r} but should be {expected!r}")


def list_variable_products():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products",
            params={"type": "variable", "per_page": 50, "page": page, "status": "publish"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for product in batch:
            yield product
        page += 1


def list_variations(product_id):
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products/{product_id}/variations",
            params={"per_page": 100, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for variation in batch:
            yield variation
        page += 1


def apply_fix(product_id, variation_id, expected_status):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}/variations/{variation_id}",
        json={"stock_status": expected_status},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def target_product_ids():
    if PRODUCT_IDS:
        return PRODUCT_IDS
    return [p["id"] for p in list_variable_products()]


def run():
    fixed = 0
    for product_id in target_product_ids():
        for variation in list_variations(product_id):
            action, reason = decide(variation)
            if action == "skip":
                continue
            expected = expected_stock_status(variation)
            log.info(
                "Variation %s (product %s): %s. %s",
                variation["id"], product_id, reason, "would fix" if DRY_RUN else "fixing",
            )
            if not DRY_RUN:
                apply_fix(product_id, variation["id"], expected)
            fixed += 1
    log.info("Done. %d variation(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
