"""Find and repair WooCommerce coupons whose usage_count was incremented
twice for the same paid order created through the REST API.

When an order is created through POST /wp-json/wc/v3/orders with
coupon_lines already attached, and the same order is then updated again
through the REST API (a retry, a fulfillment step, or an integration that
both creates and later PUTs the order to a paid status), WooCommerce can run
its usage-count hook more than once for that one order. Each run increases
the coupon's usage_count, so a coupon a single buyer redeemed once ends up
counted twice, or more, and can hit its usage_limit long before it should.

This script treats Stripe as the source of truth for "was this order paid
exactly once." For each order that carries a coupon, it reads the saved
PaymentIntent id from order meta _stripe_intent_id (falling back to
transaction_id), confirms with Stripe that the PaymentIntent succeeded, and
counts the order only once no matter how many times WooCommerce re-saved it.
It compares that trustworthy count against each coupon's usage_count and,
when usage_count is inflated, lowers it back to the correct number.

Read only by default. Run on a schedule or by hand after a spike in
"coupon usage limit reached" reports.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("coupon_usage_dedupe")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
COUPON_CODES = [c.strip() for c in os.environ.get("COUPON_CODES", "").split(",") if c.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

VALID_ORDER_STATUSES = {"processing", "completed", "on-hold"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    # Keep money math in minor units (cents) to avoid float drift.
    return round(float(order["total"]) * 100)


def counts_as_one_real_use(order, intent):
    """Pure. Decide whether a single order should count as exactly one
    coupon redemption. An order only counts when it is in a valid status and
    Stripe confirms a succeeded PaymentIntent for the order's own amount.
    """
    if order["status"] not in VALID_ORDER_STATUSES:
        return False
    if intent is None:
        return False
    if intent.get("status") != "succeeded":
        return False
    if abs(order_amount_minor(order) - intent.get("amount_received", 0)) > 1:
        return False
    return True


def decide(coupon, verified_use_count):
    """Pure decision function. No I/O.

    coupon: a dict shaped like the WooCommerce REST coupon resource, with at
      least "id", "code", and "usage_count".
    verified_use_count: the number of distinct orders that counts_as_one_real_use
      confirmed as genuine, single-counted redemptions of this coupon.

    Returns a tuple of (action, reason, corrected_count).
    """
    usage_count = coupon.get("usage_count", 0)
    if usage_count < 0:
        return ("skip", "usage_count is already negative, needs manual review", usage_count)
    if verified_use_count > usage_count:
        # Recorded count is lower than the verified real usage. That is a
        # different bug (undercounting), not the one this script repairs.
        return ("skip", "usage_count is not inflated for this order set", usage_count)
    if verified_use_count == usage_count:
        return ("skip", "usage_count matches the verified orders that used it", usage_count)
    return (
        "fix",
        f"usage_count {usage_count} is higher than the {verified_use_count} verified order(s) that used it",
        verified_use_count,
    )


def list_orders_using_coupon(code):
    """Yield every order (any page) that has this coupon code on it."""
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"page": page, "per_page": 100},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            codes = {line.get("code") for line in order.get("coupon_lines", [])}
            if code in codes:
                yield order
        page += 1


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def verified_use_count_for_coupon(code):
    """Count distinct orders that genuinely redeemed this coupon once,
    confirmed against Stripe. Each qualifying order id counts once, no
    matter how many times a buggy integration re-saved it.
    """
    seen_order_ids = set()
    for order in list_orders_using_coupon(code):
        if order["id"] in seen_order_ids:
            continue
        intent = get_intent(intent_id_of(order))
        if counts_as_one_real_use(order, intent):
            seen_order_ids.add(order["id"])
    return len(seen_order_ids)


def get_coupon(code):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/coupons",
        params={"code": code},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    matches = r.json()
    return matches[0] if matches else None


def apply_fix(coupon, corrected_count):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/coupons/{coupon['id']}",
        json={"usage_count": corrected_count},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    codes = COUPON_CODES
    if not codes:
        log.warning("No COUPON_CODES set. Nothing to check.")
        return
    fixed = 0
    for code in codes:
        coupon = get_coupon(code)
        if coupon is None:
            log.warning("Coupon %s not found", code)
            continue
        verified_count = verified_use_count_for_coupon(code)
        action, reason, corrected_count = decide(coupon, verified_count)
        if action == "skip":
            log.info("Coupon %s: %s", code, reason)
            continue
        log.info(
            "Coupon %s: %s. %s",
            code, reason, ("would set usage_count to " + str(corrected_count)) if DRY_RUN else "fixing",
        )
        if not DRY_RUN:
            apply_fix(coupon, corrected_count)
        fixed += 1
    log.info("Done. %d coupon(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
