"""Find and correct WooCommerce products and variations that oversold to negative stock.

Under a burst of concurrent orders, two checkouts can both pass the stock check and
each reduce stock, so the quantity falls below zero. Negative stock skews reports and
reorder math. This walks managed-stock products and variations, finds the ones below
zero, and sets them back to zero over the REST API (so HPOS is handled for you).
Read only by default. Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_negative_stock")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def is_oversold(item):
    """True when stock is managed and the quantity has fallen below zero."""
    if not item.get("manage_stock"):
        return False
    q = item.get("stock_quantity")
    return q is not None and q < 0


def get(path, params=None):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3{path}", params=params or {}, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def set_stock(path, product_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3{path}",
        json={"stock_quantity": 0}, auth=AUTH, timeout=30,
    ).raise_for_status()


def products():
    page = 1
    while True:
        batch = get("/products", {"per_page": 50, "page": page})
        if not batch:
            return
        for product in batch:
            yield product
        page += 1


def variations(product_id):
    page = 1
    while True:
        batch = get(f"/products/{product_id}/variations", {"per_page": 50, "page": page})
        if not batch:
            return
        for variation in batch:
            yield variation
        page += 1


def run():
    fixed = 0
    for product in products():
        targets = [("/products/%d" % product["id"], product)]
        if product.get("type") == "variable":
            targets = [(f"/products/{product['id']}/variations/{v['id']}", v) for v in variations(product["id"])]
        for path, item in targets:
            if not is_oversold(item):
                continue
            log.warning("%s is at %s. %s", path, item["stock_quantity"],
                        "would set to 0" if DRY_RUN else "setting to 0")
            if not DRY_RUN:
                set_stock(path, item["id"])
            fixed += 1
    log.info("Done. %d oversold item(s) %s.", fixed, "to correct" if DRY_RUN else "corrected")


if __name__ == "__main__":
    run()
