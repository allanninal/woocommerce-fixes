"""Find WooCommerce orders whose Analytics stats disagree with the real order,
the classic symptom left behind by a High-Performance Order Storage (HPOS) migration,
and nudge each one back into sync. Read only by default. Run on a schedule or once
after a migration.
"""
import os
import time
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resync_order_stats")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Orders in these statuses should have a matching row in the analytics
# lookup tables with a total_sales greater than zero.
COUNTED_STATUSES = {"processing", "completed", "on-hold", "refunded"}


def order_amount_minor(order):
    """Order total in minor units (cents). Two decimal currencies only."""
    return round(float(order["total"]) * 100)


def report_amount_minor(report_row):
    """Analytics report row total in minor units (cents)."""
    return round(float(report_row.get("total_sales", 0)) * 100)


def decide(order, report_row):
    """Pure decision function. No I/O.

    order: dict from GET /wp-json/wc/v3/orders/{id}
    report_row: dict from GET /wp-json/wc-analytics/reports/orders?order_id={id}
                or None when no row exists for that order.

    Returns a tuple of (action, reason) where action is one of:
      "skip"   - order status is not one Analytics is expected to count
      "missing"- order should be counted but has no stats row at all
      "resync" - a stats row exists but disagrees with the real order
      "ok"     - the stats row matches the real order
    """
    status = order["status"]
    if status not in COUNTED_STATUSES:
        return ("skip", "order status is not counted in Analytics")

    if report_row is None:
        return ("missing", "no Analytics stats row for a countable order")

    if report_row.get("status") != status:
        return ("resync", "stats row has a stale status")

    if abs(order_amount_minor(order) - report_amount_minor(report_row)) > 1:
        return ("resync", "stats row total does not match the order total")

    return ("ok", "stats row matches the order")


def list_orders(lookback_days):
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=lookback_days)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"after": after, "per_page": 50, "page": page, "orderby": "date", "order": "asc"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def get_report_row(order_id):
    """The Analytics report line for one order, or None when it has no row yet."""
    r = requests.get(
        f"{WOO_URL}/wp-json/wc-analytics/reports/orders",
        params={"order_id": order_id, "per_page": 1},
        auth=AUTH, timeout=30,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None


def touch_order(order):
    """Re-save the order through the CRUD layer so WooCommerce re-fires the hooks
    that rebuild its Analytics stats row. Setting the status to its own value is
    enough: it goes through wc_get_order()->save() on the way in, which is the
    same path the built-in "Regenerate data" tool uses under the hood, just for
    one order instead of the whole store.
    """
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"status": order["status"]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": "Analytics stats resynced after an HPOS migration mismatch. "
                      "Order data was untouched; only the stats lookup row was rebuilt."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    resynced = 0
    checked = 0
    for order in list_orders(LOOKBACK_DAYS):
        checked += 1
        report_row = get_report_row(order["id"])
        action, reason = decide(order, report_row)
        if action in ("skip", "ok"):
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would resync" if DRY_RUN else "resyncing")
        if not DRY_RUN:
            touch_order(order)
            time.sleep(0.2)  # be gentle with wp-cron and the stats rebuild queue
        resynced += 1
    log.info("Done. Checked %d order(s). %d %s.", checked, resynced, "to resync" if DRY_RUN else "resynced")


if __name__ == "__main__":
    run()
