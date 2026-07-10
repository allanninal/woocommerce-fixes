"""Detect and strip a non recurring coupon that got applied to a subscription renewal.

WooCommerce Subscriptions only carries a coupon onto renewal orders when the coupon
is one of the recurring discount types (recurring_percent, recurring_fixed_cart,
recurring_fixed_product). A normal one time coupon (percent, fixed_cart,
fixed_product) should only ever discount the first, parent order. If one is found
sitting on a renewal, it is almost always a leftover from a manual coupon add, an
older Subscriptions version, or a support agent applying a "first order only" code
by hand. Left alone it quietly discounts every future renewal forever.

This walks the renewal orders on each subscription, finds coupons whose discount
type is not in the recurring set, removes the coupon line from the order, and
recalculates the order totals so the renewal charges the correct amount next time.
Safe by default. Run on a schedule or by hand against one subscription.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("strip_bad_renewal_coupons")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_SUBSCRIPTIONS = int(os.environ.get("LOOKBACK_SUBSCRIPTIONS", "200"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# The only discount types WooCommerce Subscriptions will keep applying to renewals.
RECURRING_TYPES = {"recurring_percent", "recurring_fixed_cart", "recurring_fixed_product"}

# Renewal orders carry a link back to the subscription and a flag showing they are
# a renewal, not the original purchase.
RENEWAL_META_KEY = "_subscription_renewal"


def is_renewal_order(order):
    """A renewal order has _subscription_renewal in its meta_data."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == RENEWAL_META_KEY:
            return True
    return False


def money_to_minor(amount):
    """Convert a WooCommerce decimal money string to integer cents."""
    return round(float(amount) * 100)


def bad_coupons_on_order(order, coupon_types_by_code):
    """Return the list of coupon lines on a renewal order whose discount type is
    not a recurring type. coupon_types_by_code maps coupon code (lowercase) to its
    WooCommerce discount_type, e.g. {"welcome10": "percent"}.
    """
    bad = []
    for line in order.get("coupon_lines") or []:
        code = (line.get("code") or "").lower()
        discount_type = coupon_types_by_code.get(code)
        if discount_type is not None and discount_type not in RECURRING_TYPES:
            bad.append(line)
    return bad


def decide(order, coupon_types_by_code):
    """Pure decision function. No I/O.

    Returns (action, reason, bad_coupon_lines).
    action is one of: "skip", "fix".
    """
    if not is_renewal_order(order):
        return ("skip", "not a renewal order", [])
    if order.get("status") in ("cancelled", "refunded", "failed", "trash"):
        return ("skip", "order is not in a state worth editing", [])
    bad = bad_coupons_on_order(order, coupon_types_by_code)
    if not bad:
        return ("skip", "no non recurring coupon on this renewal", [])
    return ("fix", "a non recurring coupon is applied to a renewal", bad)


def discount_minor_of(lines):
    """Sum the discount amount (in minor units) across coupon lines."""
    total = 0
    for line in lines:
        total += money_to_minor(line.get("discount") or "0")
    return total


def get_subscriptions(per_page=50):
    page = 1
    seen = 0
    while seen < LOOKBACK_SUBSCRIPTIONS:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"per_page": per_page, "page": page, "status": "active"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            seen += 1
            yield sub
        page += 1


def get_renewal_orders(subscription_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/orders",
        params={"type": "renewal"},
        auth=AUTH, timeout=30,
    )
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return r.json()


def get_coupon_types(codes):
    """Look up discount_type for a set of coupon codes. Returns {code_lower: type}."""
    types = {}
    for code in codes:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/coupons",
            params={"code": code},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        matches = r.json()
        if matches:
            types[code.lower()] = matches[0].get("discount_type")
    return types


def strip_coupon(order_id, bad_lines):
    """Remove the bad coupon line(s) from the order and recalc the total."""
    for line in bad_lines:
        requests.delete(
            f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/coupons/{line['id']}",
            auth=AUTH, timeout=30,
        ).raise_for_status()
    added_back = discount_minor_of(bad_lines)
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": (
            "Removed a non recurring coupon that had been applied to this renewal. "
            f"Restored {added_back / 100:.2f} to the order total. Fixed by "
            "strip_bad_renewal_coupons."
        )},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for sub in get_subscriptions():
        renewals = get_renewal_orders(sub["id"])
        if not renewals:
            continue
        codes = set()
        for order in renewals:
            for line in order.get("coupon_lines") or []:
                if line.get("code"):
                    codes.add(line["code"])
        if not codes:
            continue
        coupon_types_by_code = get_coupon_types(codes)
        for order in renewals:
            action, reason, bad_lines = decide(order, coupon_types_by_code)
            if action == "skip":
                continue
            codes_str = ", ".join(l.get("code", "?") for l in bad_lines)
            log.info(
                "Renewal order %s on subscription %s: %s (%s). %s",
                order["id"], sub["id"], reason, codes_str,
                "would fix" if DRY_RUN else "fixing",
            )
            if not DRY_RUN:
                strip_coupon(order["id"], bad_lines)
            fixed += 1
    log.info("Done. %d renewal order(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
