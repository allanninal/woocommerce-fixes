"""Release coupon usage that failed WooCommerce orders should not be holding.

WooCommerce increases a coupon's usage_count, and records the billing email under
_used_by, the moment an order is placed with that coupon attached, before payment is
confirmed. When the order later fails (a declined card, an abandoned Stripe
PaymentIntent, a gateway error), WooCommerce is supposed to release that usage back.
In practice a lot of failure paths never call it: the order goes straight from
pending to failed without passing through the cancelled transition, the store uses
High Performance Order Storage (HPOS) with a plugin that intercepts the status
change, or the failure happens on a redirect and the customer never returns to
trigger it. The coupon then looks used up, or a single customer looks like they hit
usage_limit_per_user, when the truth is Stripe never took a payment. This walks
recent failed orders, checks the Stripe PaymentIntent tied to the order (if any), and
for every failed order whose coupon usage was never released, removes that order's
email from the coupon's used_by list and decrements usage_count by one. Safe to run
again and again, since it never touches a coupon usage entry more than once. Read
only until DRY_RUN is turned off.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("release_failed_coupons")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Statuses that mean the sale never actually happened, so any coupon usage tied to
# the order should have been released.
RELEASABLE_STATUSES = {"failed", "cancelled"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_customer_key(order):
    """The identity WooCommerce records on a coupon's used_by list for this order."""
    email = (order.get("billing") or {}).get("email")
    if email:
        return email
    customer_id = order.get("customer_id")
    return str(customer_id) if customer_id else None


def decide(order, intent, coupon):
    """Pure decision: should this order's coupon usage be released?

    order  - a WooCommerce order dict (status, coupon_lines, billing, meta_data, ...)
    intent - the Stripe PaymentIntent dict for this order, or None if there is none
             or it could not be found
    coupon - the WooCommerce coupon dict for one code on the order (used_by, usage_count)

    Returns a (action, reason) tuple. action is one of:
      "skip"    - nothing to do, leave the coupon alone
      "release" - remove this order's usage from the coupon
    """
    if order.get("status") not in RELEASABLE_STATUSES:
        return ("skip", "order did not fail, usage is legitimate")
    if intent is not None and intent.get("status") == "succeeded":
        # Stripe disagrees with WooCommerce: the payment actually went through.
        # Do not touch the coupon. That is a different problem (see the paid
        # orders stuck on pending guide).
        return ("skip", "Stripe shows the payment succeeded, order status is wrong")
    key = order_customer_key(order)
    if not key:
        return ("skip", "no billing email or customer id to match against used_by")
    used_by = coupon.get("used_by") or []
    if key not in used_by:
        return ("skip", "coupon usage already released for this order")
    return ("release", "failed order still holding a coupon usage slot")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def failed_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "failed,cancelled", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            if order.get("coupon_lines"):
                yield order
        page += 1


def get_coupon_by_code(code):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/coupons",
        params={"code": code}, auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    matches = r.json()
    return matches[0] if matches else None


def release_usage(coupon, key):
    used_by = list(coupon.get("used_by") or [])
    used_by.remove(key)
    new_count = max(0, int(coupon.get("usage_count", 0)) - 1)
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/coupons/{coupon['id']}",
        json={"used_by": used_by, "usage_count": new_count},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    released = 0
    for order in failed_orders():
        intent = get_intent(intent_id_of(order))
        for line in order["coupon_lines"]:
            coupon = get_coupon_by_code(line["code"])
            if coupon is None:
                log.warning("Order %s used coupon %s which no longer exists", order["id"], line["code"])
                continue
            action, reason = decide(order, intent, coupon)
            if action == "skip":
                continue
            key = order_customer_key(order)
            log.info(
                "Order %s / coupon %s: %s. %s",
                order["id"], line["code"], reason, "would release" if DRY_RUN else "releasing",
            )
            if not DRY_RUN:
                release_usage(coupon, key)
            released += 1
    log.info("Done. %d coupon usage slot(s) %s.", released, "to release" if DRY_RUN else "released")


if __name__ == "__main__":
    run()
