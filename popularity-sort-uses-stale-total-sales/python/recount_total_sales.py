"""Recount WooCommerce's total_sales product meta from real, paid orders.

The "Popularity" catalog sort orders products by the total_sales number stored
on each product. WooCommerce core only bumps that number through its own order
status hooks, so it drifts from reality whenever orders are imported straight
into the database, a status is changed by another plugin or a direct SQL
update, or a refund and cancellation never decrements it back down. This walks
paid orders in a lookback window, sums real quantities per product (minus
refunded quantities), compares that to the stored total_sales, and corrects
any product whose number is wrong. Read only by default. Run on a schedule.
"""
import os
import logging
import requests
from collections import defaultdict
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recount_total_sales")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "365"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# WooCommerce counts a sale once the order reaches one of these statuses.
SALE_COUNTED_STATUSES = {"processing", "completed"}


def decide(stored_total_sales, real_total_sales):
    """Pure decision: should we rewrite a product's total_sales meta?

    stored_total_sales: the int currently saved on the product (what Popularity sorts by).
    real_total_sales: the int we computed from real order line items and refunds.
    Returns a tuple of (action, reason). action is one of "fix", "skip".
    """
    try:
        stored = int(stored_total_sales)
    except (TypeError, ValueError):
        stored = 0
    real = max(0, int(real_total_sales))
    if stored == real:
        return ("skip", "total_sales already correct")
    return ("fix", f"stored {stored}, real {real}")


def net_quantity(line_item):
    """Quantity actually sold for one order line item, in whole units.

    A negative qty on a refund line item cancels out units from the original
    order line item for the same product.
    """
    try:
        return int(line_item.get("quantity") or 0)
    except (TypeError, ValueError):
        return 0


def paid_orders(after_iso):
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={
                "status": "processing,completed",
                "after": after_iso,
                "per_page": 100,
                "page": page,
            },
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def refund_line_items(order_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/refunds",
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    for refund in r.json():
        for item in refund.get("line_items", []):
            yield item


def real_sales_by_product(lookback_days):
    """Sum real, paid quantity per product_id across the lookback window."""
    import datetime

    after = (datetime.date.today() - datetime.timedelta(days=lookback_days)).isoformat() + "T00:00:00"
    totals = defaultdict(int)
    for order in paid_orders(after):
        for item in order.get("line_items", []):
            product_id = item.get("product_id")
            if not product_id:
                continue
            totals[product_id] += net_quantity(item)
        for item in refund_line_items(order["id"]):
            product_id = item.get("product_id")
            if not product_id:
                continue
            # Refund line items carry a negative quantity already.
            totals[product_id] += net_quantity(item)
    return totals


def get_product(product_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/products/{product_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def write_total_sales(product_id, real_total_sales):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json={"total_sales": str(real_total_sales)},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    totals = real_sales_by_product(LOOKBACK_DAYS)
    for product_id, real_total_sales in totals.items():
        product = get_product(product_id)
        if product is None:
            log.warning("Product %s has sales but no longer exists, skipping", product_id)
            continue
        action, reason = decide(product.get("total_sales"), real_total_sales)
        if action == "skip":
            continue
        log.info("Product %s: %s. %s", product_id, reason, "would fix" if DRY_RUN else "fixing")
        if not DRY_RUN:
            write_total_sales(product_id, real_total_sales)
        fixed += 1
    log.info("Done. %d product(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
