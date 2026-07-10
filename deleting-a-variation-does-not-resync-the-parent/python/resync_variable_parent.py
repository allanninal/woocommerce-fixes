"""Fix WooCommerce variable products whose price range and stock status went stale
after a variation was deleted.

Deleting a variation removes that row, but nothing tells the parent product to
recompute its cached `_price`, `_min_variation_price` / `_max_variation_price`,
or `_stock_status`. The parent keeps showing the old range (or "In stock" when
every remaining variation is out of stock) until something forces a resync.

This walks variable products, reads their live variations from the REST API,
computes what the parent's price range and stock status should be, and repairs
any parent whose cached values disagree. Safe to run again and again. Dry run
by default.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resync_variable_parent")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

IN_STOCK = "instock"
OUT_OF_STOCK = "outofstock"
ON_BACKORDER = "onbackorder"


def price_minor(value):
    """Turn a WooCommerce price string into integer cents. Empty means unset."""
    if value in (None, ""):
        return None
    return round(float(value) * 100)


def expected_state(variations):
    """Work out what the parent's price range and stock status should be,
    given the variations that are left after a delete. Purchasable variations
    (published, with a price) decide the range. Stock status follows the same
    rule WooCommerce uses: in stock if any purchasable variation is in stock or
    on backorder, out of stock only when every one of them is out of stock.
    """
    purchasable = [
        v for v in variations
        if v.get("status") == "publish" and price_minor(v.get("price")) is not None
    ]
    if not purchasable:
        return {"min_price": None, "max_price": None, "stock_status": OUT_OF_STOCK}

    prices = [price_minor(v["price"]) for v in purchasable]
    statuses = {v.get("stock_status") for v in purchasable}
    if statuses & {IN_STOCK, ON_BACKORDER}:
        stock_status = IN_STOCK if IN_STOCK in statuses else ON_BACKORDER
    else:
        stock_status = OUT_OF_STOCK

    return {"min_price": min(prices), "max_price": max(prices), "stock_status": stock_status}


def decide(parent, variations):
    """Pure decision function. No I/O. Returns (action, reason, expected).

    action is one of:
      "skip"   - parent is not a variable product, or nothing is out of sync
      "no-variations" - all variations are gone, parent should show unpurchasable
      "fix"    - the cached parent values disagree with what the live variations say
    """
    if parent.get("type") != "variable":
        return ("skip", "not a variable product", None)

    expected = expected_state(variations)

    if not variations:
        cached_status = parent.get("stock_status")
        if cached_status == OUT_OF_STOCK and parent.get("price") in (None, ""):
            return ("skip", "already reflects no variations", expected)
        return ("no-variations", "every variation was deleted, parent still shows stale data", expected)

    # The REST API exposes the parent's cached low price as "price". A healthy
    # variable product keeps "price" equal to the lowest live variation price.
    cached_min = price_minor(parent.get("price"))
    cached_status = parent.get("stock_status")

    mismatched_price = expected["min_price"] is not None and cached_min != expected["min_price"]
    mismatched_stock = cached_status != expected["stock_status"]

    if mismatched_price or mismatched_stock:
        return ("fix", "parent price range or stock status is stale after a variation delete", expected)

    return ("skip", "parent already matches its live variations", expected)


def get_variable_products():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products",
            params={"type": "variable", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for product in batch:
            yield product
        page += 1


def get_variations(product_id):
    variations = []
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
            break
        variations.extend(batch)
        page += 1
    return variations


def apply_fix(product_id, expected):
    """Force WooCommerce to recompute the parent by touching one of its own
    variations (a zero-length variation batch update). WooCommerce's variable
    product data store runs WC_Product_Variable::sync on that call, which
    rebuilds price range and stock status from the variations that still
    exist. We also PUT the expected values directly so the storefront is
    correct even before the next full save.
    """
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}/variations/batch",
        json={"update": []},
        auth=AUTH, timeout=30,
    ).raise_for_status()

    payload = {"stock_status": expected["stock_status"]}
    if expected["min_price"] is not None:
        payload["regular_price"] = f"{expected['min_price'] / 100:.2f}"
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json=payload,
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for product in get_variable_products():
        variations = get_variations(product["id"])
        action, reason, expected = decide(product, variations)
        if action == "skip":
            continue
        log.info(
            "Product %s: %s. %s",
            product["id"], reason, "would fix" if DRY_RUN else "fixing",
        )
        if not DRY_RUN:
            apply_fix(product["id"], expected)
        fixed += 1
    log.info("Done. %d product(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
