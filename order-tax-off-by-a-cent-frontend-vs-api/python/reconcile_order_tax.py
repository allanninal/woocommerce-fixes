"""Find WooCommerce orders where the stored tax total does not match the tax you
get from re-adding the line item taxes, the same math the frontend cart used.

The checkout page rounds tax per line item as the buyer shops. The order that
gets saved can end up with a total_tax that was rounded a different way, so the
two numbers can disagree by a cent or two. This walks recent orders, recomputes
the expected tax from the saved line items in integer cents, and flags or fixes
any order whose stored total_tax drifts from that recomputed value. Safe by
default. Run on a schedule.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_order_tax")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
MAX_DRIFT_CENTS = int(os.environ.get("MAX_DRIFT_CENTS", "3"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Orders in these statuses are still moving. Only reconcile settled money.
SETTLED_STATUSES = {"processing", "completed", "on-hold"}


def to_minor(amount):
    """Turn a WooCommerce money string like "12.345" into integer cents,
    rounding half away from zero the same way most tax engines do.
    """
    cents = float(amount) * 100
    if cents >= 0:
        return int(cents + 0.5)
    return -int(-cents + 0.5)


def line_item_tax_minor(item):
    """Sum the per-rate tax entries on one line item, in cents.
    WooCommerce stores this per item as taxes.total, a dict of rate_id -> amount.
    """
    taxes = (item.get("taxes") or {}).get("total") or {}
    total = 0
    for _rate_id, amount in taxes.items():
        if amount not in (None, ""):
            total += to_minor(amount)
    return total


def expected_tax_minor(order):
    """Recompute the order tax by re-adding every line item's own tax, the same
    rounded-per-line approach the cart and checkout page use while shopping.
    Covers line_items, shipping_lines, and fee_lines, since all three can carry tax.
    """
    total = 0
    for item in order.get("line_items", []):
        total += line_item_tax_minor(item)
    for item in order.get("shipping_lines", []):
        total += line_item_tax_minor(item)
    for item in order.get("fee_lines", []):
        total += line_item_tax_minor(item)
    return total


def stored_tax_minor(order):
    return to_minor(order.get("total_tax", "0"))


def decide(order, max_drift_cents=MAX_DRIFT_CENTS):
    """Pure decision: compare the stored tax total against the tax recomputed
    from the order's own line items. No network calls, no Stripe involved,
    this is purely a WooCommerce order math question.
    """
    if order["status"] not in SETTLED_STATUSES:
        return ("skip", "order not settled yet")
    expected = expected_tax_minor(order)
    stored = stored_tax_minor(order)
    drift = stored - expected
    if drift == 0:
        return ("ok", "tax matches the line items")
    if abs(drift) > max_drift_cents:
        return ("review", f"tax off by {drift} cents, too large to auto fix")
    return ("fix", f"tax off by {drift} cents, adjusting total_tax to {expected}")


def minor_to_amount(minor):
    sign = "-" if minor < 0 else ""
    minor = abs(minor)
    return f"{sign}{minor // 100}.{minor % 100:02d}"


def get_orders(page, after):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"status": "processing,completed,on-hold", "after": after, "per_page": 50, "page": page},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def recent_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        batch = get_orders(page, after)
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def apply_fix(order, expected_minor):
    """Set total_tax to the recomputed value and leave a note explaining why.
    We only touch the order-level total_tax field, never the line items
    themselves, so refunds and reports that read line item tax are unaffected.
    """
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"total_tax": minor_to_amount(expected_minor)},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": "Tax reconciler: stored total_tax did not match the sum of the "
                      "line item taxes. Adjusted total_tax to match the line items."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    flagged = 0
    for order in recent_orders():
        action, reason = decide(order)
        if action == "skip" or action == "ok":
            continue
        if action == "review":
            log.warning("Order %s: %s. Needs a human look.", order["id"], reason)
            flagged += 1
            continue
        expected = expected_tax_minor(order)
        log.info("Order %s: %s. %s", order["id"], reason, "would fix" if DRY_RUN else "fixing")
        if not DRY_RUN:
            apply_fix(order, expected)
        fixed += 1
    log.info("Done. %d order(s) %s, %d flagged for review.",
              fixed, "to fix" if DRY_RUN else "fixed", flagged)


if __name__ == "__main__":
    run()
