"""Find WooCommerce orders where stock was reduced more than once, and add the
extra units back. Read only in dry run. Safe to run again and again, since it
only ever restores the amount above a single clean reduction.

Guide: https://www.allanninal.dev/woocommerce/double-stock-reduction/
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth
from datetime import date, timedelta

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_double_stock")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

STOCK_REDUCED_STATUSES = ("processing", "completed", "on-hold")


def order_expected_qty(order):
    """Total units this order should have removed from stock, once."""
    return sum(int(item.get("quantity") or 0) for item in order.get("line_items") or [])


def recorded_reduced_qty(order):
    """Total units actually removed from stock for this order, from meta."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stock_reduced_qty" and meta.get("value"):
            return int(meta["value"])
    return None


def decide(order, expected_qty, recorded_qty):
    """Pure decision function. No I/O. Returns (action, reason, extra_units).

    action is one of:
      "orphan" - the order could not be found
      "skip"   - nothing to do
      "review" - looks off but is not a clean multiple, needs a human
      "fix"    - stock was reduced more than once, extra_units should be restored
    """
    if order is None:
        return ("orphan", "order not found", 0)
    if order.get("status") not in STOCK_REDUCED_STATUSES:
        return ("skip", "order not in a stock-reduced state", 0)
    if not expected_qty:
        return ("skip", "order has no line item quantity", 0)
    if recorded_qty is None:
        return ("skip", "no recorded reduction to compare", 0)
    if recorded_qty <= expected_qty:
        return ("skip", "reduction matches or is under the order total", 0)
    if recorded_qty % expected_qty != 0:
        return ("review", "reduction is extra but not a clean multiple", 0)
    times = recorded_qty // expected_qty
    if times < 2:
        return ("skip", "reduction matches the order total", 0)
    extra_units = expected_qty * (times - 1)
    return ("fix", f"stock reduced {times}x for one order", extra_units)


def candidate_orders():
    page = 1
    after = f"{date.today() - timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": ",".join(STOCK_REDUCED_STATUSES), "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def restore_stock(order, extra_units):
    for item in order.get("line_items") or []:
        product_id = item.get("product_id")
        qty = int(item.get("quantity") or 0)
        if not product_id or not qty:
            continue
        product = requests.get(f"{WOO_URL}/wp-json/wc/v3/products/{product_id}", auth=AUTH, timeout=30).json()
        if not product.get("manage_stock"):
            continue
        current = int(product.get("stock_quantity") or 0)
        add_back = qty  # this line's share of one extra full reduction
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
            json={"stock_quantity": current + add_back},
            auth=AUTH, timeout=30,
        ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Stock repair: {extra_units} extra unit(s) were removed by a duplicate "
                      f"reduction and have been added back. First reduction was left in place."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for order in candidate_orders():
        expected_qty = order_expected_qty(order)
        recorded_qty = recorded_reduced_qty(order)
        action, reason, extra_units = decide(order, expected_qty, recorded_qty)
        if action == "orphan":
            log.warning("Order missing while checking stock reduction")
            continue
        if action in ("skip", "review"):
            if action == "review":
                log.warning("Order %s: %s, needs a human look", order["id"], reason)
            continue
        log.info("Order %s: %s. %s %d unit(s)", order["id"], reason,
                  "would restore" if DRY_RUN else "restoring", extra_units)
        if not DRY_RUN:
            restore_stock(order, extra_units)
        fixed += 1
    log.info("Done. %d order(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
