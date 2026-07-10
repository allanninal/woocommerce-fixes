"""Recount WooCommerce coupon usage from real, paid orders and repair a wrong usage_count.

WooCommerce tracks how many times a coupon was used with a single number,
usage_count, stored on the coupon itself. Two checkouts that apply the same
coupon at nearly the same moment can both read the old number and both write
back old_number + 1, so one use is lost. A cancelled, failed, or refunded
order can also fail to give its use back. Either way the stored count drifts
from reality, and a limited coupon can be used more times than the shop
owner intended, or looks used up when it still has room.

This script asks WooCommerce for orders that used the coupon, keeps only the
ones that are genuinely paid, and confirms "genuinely paid" against Stripe by
looking up the order's PaymentIntent (from order meta _stripe_intent_id, or
transaction_id when it looks like a PaymentIntent id) and checking its
status is succeeded. That real count is compared to the coupon's stored
usage_count, and the stored number is corrected when it disagrees. Read only
by default. Safe to run again and again.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recount_coupon_usage")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Orders in these statuses are worth checking with Stripe at all. Anything
# else (cancelled, failed, refunded, pending, trash) never counts as a use.
CANDIDATE_STATUSES = {"processing", "completed", "on-hold"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_counts_as_used(order, intent):
    """Pure rule: does this order count as one real, kept use of a coupon?

    order: a dict with at least "status".
    intent: a Stripe PaymentIntent dict (or object with attribute access), or
      None when no PaymentIntent could be found or loaded for the order.

    An order counts only when it is in a candidate status AND Stripe confirms
    the matching PaymentIntent actually succeeded. No PaymentIntent, or a
    PaymentIntent that is not succeeded, means the order does not count, no
    matter what status WooCommerce shows.
    """
    if order.get("status") not in CANDIDATE_STATUSES:
        return False
    if intent is None:
        return False
    status = intent.get("status") if isinstance(intent, dict) else intent.status
    return status == "succeeded"


def decide(coupon, real_count):
    """Pure decision: compare the coupon's stored usage_count to the real
    count of orders confirmed used and paid, and say whether to correct it.

    coupon: a dict with at least "id", "code", "usage_count".
    real_count: an int, the number of confirmed-paid orders using this coupon.

    Returns a tuple of (action, reason) where action is one of:
      "ok"      the stored count already matches, nothing to do
      "correct" the stored count is wrong, write real_count over it
    """
    stored = int(coupon.get("usage_count", 0))
    if stored == real_count:
        return ("ok", "usage_count already matches real orders")
    if stored < real_count:
        return ("correct", f"undercounted: stored {stored}, real {real_count}")
    return ("correct", f"overcounted: stored {stored}, real {real_count}")


def list_coupons():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/coupons",
            params={"per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for coupon in batch:
            yield coupon
        page += 1


def orders_using(coupon_code):
    """Every order (any status) whose coupon_lines mention this code."""
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"per_page": 50, "page": page, "status": "any"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            codes = {line.get("code") for line in order.get("coupon_lines") or []}
            if coupon_code in codes:
                yield order
        page += 1


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def real_usage_count(coupon_code):
    count = 0
    for order in orders_using(coupon_code):
        if order.get("status") not in CANDIDATE_STATUSES:
            continue
        intent = get_intent(intent_id_of(order))
        if order_counts_as_used(order, intent):
            count += 1
    return count


def correct_usage_count(coupon_id, real_count):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/coupons/{coupon_id}",
        json={"usage_count": real_count},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    corrected = 0
    for coupon in list_coupons():
        real_count = real_usage_count(coupon["code"])
        action, reason = decide(coupon, real_count)
        if action == "ok":
            continue
        log.info(
            "Coupon %s (%s): %s. %s",
            coupon["code"], coupon["id"], reason, "would correct" if DRY_RUN else "correcting",
        )
        if not DRY_RUN:
            correct_usage_count(coupon["id"], real_count)
        corrected += 1
    log.info("Done. %d coupon(s) %s.", corrected, "to correct" if DRY_RUN else "corrected")


if __name__ == "__main__":
    run()
