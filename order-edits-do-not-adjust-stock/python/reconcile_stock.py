"""Reconcile product stock after an order was edited in the WooCommerce admin.

WooCommerce reduces stock once, when an order first moves to a stock reducing
status, and stamps how much it took on each line item in `_reduced_stock` meta.
If a shop manager later edits the order (changes a quantity, removes a line,
adds a new line, deletes the whole order) WooCommerce does not revisit that
stock. This walks recent orders, compares each line item's current quantity
against its `_reduced_stock` meta, and restocks or further reduces the
difference so the product stock matches what the order actually charged for.

Read only by default (DRY_RUN=true). Run on a schedule.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_stock")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

STOCK_REDUCED_STATUSES = {"processing", "completed", "on-hold"}


def reduced_stock_of(line_item):
    """The quantity WooCommerce already took out of stock for this line item,
    read from its `_reduced_stock` meta. Zero when the meta is missing, which
    means the line was added after the order's stock reduction ran."""
    for meta in line_item.get("meta_data") or []:
        if meta.get("key") == "_reduced_stock":
            try:
                return int(meta["value"])
            except (TypeError, ValueError):
                return 0
    return 0


def line_items_needing_sync(order):
    """Every stock managed line item whose current quantity does not match
    the quantity WooCommerce already reduced from stock."""
    if order["status"] not in STOCK_REDUCED_STATUSES:
        return []
    out = []
    for item in order.get("line_items") or []:
        if not item.get("product_id"):
            continue
        reduced = reduced_stock_of(item)
        current = int(item.get("quantity") or 0)
        if reduced != current:
            out.append({
                "product_id": item["product_id"],
                "variation_id": item.get("variation_id") or 0,
                "sku": item.get("sku", ""),
                "reduced": reduced,
                "current": current,
                "delta": current - reduced,
            })
    return out


def decide(order, product):
    """Pure decision for one out-of-sync line item against its product record.

    order    - a dict with at least "status" and the order id
    product  - a dict with at least "manage_stock" and "stock_quantity", or
               None when the product could not be found

    Returns (action, reason). Actions:
      "skip"    - nothing to do, order not in a stock reducing status
      "orphan"  - the product behind the line item no longer exists
      "unmanaged" - product does not track stock, so there is nothing to sync
      "adjust"  - stock should move by `delta` (negative reduces, positive restocks)
    """
    if order["status"] not in STOCK_REDUCED_STATUSES:
        return ("skip", "order not in a stock reducing status")
    if product is None:
        return ("orphan", "product for this line item no longer exists")
    if not product.get("manage_stock"):
        return ("unmanaged", "product does not manage stock")
    return ("adjust", "line item quantity no longer matches reduced stock")


def apply_delta(current_stock, delta):
    """New stock quantity after applying delta, in whole units, never negative."""
    return max(0, int(current_stock) + int(delta))


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_product(product_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/products/{product_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def recent_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "processing,completed,on-hold", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def set_stock(product_id, new_qty):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json={"stock_quantity": new_qty, "manage_stock": True},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def stamp_reduced_stock(order_id, line_item_id, quantity):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"line_items": [{"id": line_item_id, "meta_data": [{"key": "_reduced_stock", "value": str(quantity)}]}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def add_note(order_id, note):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": note},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for order in recent_orders():
        items = line_items_needing_sync(order)
        for item in items:
            product = get_product(item["product_id"])
            action, reason = decide(order, product)
            if action in ("skip", "orphan", "unmanaged"):
                if action == "orphan":
                    log.warning("Order %s product %s missing: %s", order["id"], item["product_id"], reason)
                continue
            new_qty = apply_delta(product["stock_quantity"] or 0, item["delta"])
            log.info(
                "Order %s product %s: reduced=%s current=%s delta=%+d -> stock %s. %s",
                order["id"], item["product_id"], item["reduced"], item["current"],
                item["delta"], new_qty, "would fix" if DRY_RUN else "fixing",
            )
            if not DRY_RUN:
                set_stock(item["product_id"], new_qty)
                add_note(
                    order["id"],
                    f"Stock reconciled for product #{item['product_id']}: order edit changed the "
                    f"quantity from {item['reduced']} to {item['current']}, stock adjusted by "
                    f"{item['delta']:+d} to {new_qty}.",
                )
            fixed += 1
    log.info("Done. %d line item(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
