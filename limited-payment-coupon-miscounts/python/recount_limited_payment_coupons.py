"""Recount and repair a WooCommerce Subscriptions coupon limited to N renewal payments.

A coupon can be set to discount only a subscription's first N renewal payments
(the "Active for x payments" field WooCommerce Subscriptions adds to a coupon).
Each subscription keeps a running counter of how many payments that coupon has
already discounted, in item meta on the subscription. A failed-then-retried
renewal, or a plan switch, can make that counter skip a count or add one twice,
so the coupon keeps discounting past its real limit (a quiet revenue leak) or
stops discounting a payment early (a support ticket).

This walks subscriptions carrying the coupon, recounts the payments it should
have discounted by looking at the subscription's own paid renewal order
history (each renewal order's line item carries a coupon snapshot with the
per-payment discount total, and its PaymentIntent is confirmed against
Stripe), compares that to the stored counter, and repairs the counter when it
disagrees. Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recount_limited_payment_coupons")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

COUNTER_META_PREFIX = "_coupon_number_payments_"
PAID_ORDER_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def stored_counter(subscription, coupon_code):
    """The counter WooCommerce Subscriptions keeps for this coupon on this subscription."""
    key = f"{COUNTER_META_PREFIX}{coupon_code.lower()}"
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == key:
            try:
                return int(meta["value"])
            except (TypeError, ValueError):
                return None
    return None


def renewal_order_ids(subscription):
    """Renewal order ids attached to the subscription, oldest first."""
    ids = subscription.get("renewal_order_ids")
    if ids is None:
        ids = [ro.get("id") for ro in subscription.get("_links", {}).get("renewals", [])]
    return list(ids or [])


def order_applied_coupon(order, coupon_code):
    """True if this order's line items show the coupon code was applied."""
    for line in order.get("coupon_lines") or []:
        if (line.get("code") or "").lower() == coupon_code.lower():
            return True
    return False


def true_payment_count(renewal_orders, coupon_code, verified_intent_ids):
    """Recount from real orders: paid, coupon applied, and Stripe confirms the charge.

    renewal_orders: list of WooCommerce order dicts for the subscription's renewals.
    verified_intent_ids: set of PaymentIntent ids Stripe reports as succeeded.
    """
    count = 0
    for order in renewal_orders:
        if order.get("status") not in PAID_ORDER_STATUSES:
            continue
        if not order_applied_coupon(order, coupon_code):
            continue
        intent_id = intent_id_of(order)
        if intent_id is not None and intent_id not in verified_intent_ids:
            # Stripe does not confirm this one, do not count it as a real payment.
            continue
        count += 1
    return count


def decide(subscription, coupon_code, true_count):
    """Pure decision: compare the stored counter to the recounted truth.

    Returns (action, reason) where action is one of:
      "skip"    stored counter already matches the true count
      "repair"  stored counter is wrong and should be written back
      "unknown" the subscription has no stored counter for this coupon yet
    """
    stored = stored_counter(subscription, coupon_code)
    if stored is None:
        return ("unknown", "no stored counter found for this coupon")
    if stored == true_count:
        return ("skip", "counter already matches the real payment count")
    direction = "ahead of" if stored > true_count else "behind"
    return ("repair", f"stored counter ({stored}) is {direction} the real count ({true_count})")


def woo_get(path, params=None):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def subscriptions_with_coupon(coupon_code):
    page = 1
    while True:
        batch = woo_get("/subscriptions", params={"per_page": 50, "page": page})
        if not batch:
            return
        for sub in batch:
            codes = {(line.get("code") or "").lower() for line in sub.get("coupon_lines") or []}
            if coupon_code.lower() in codes:
                yield sub
        page += 1


def get_renewal_orders(subscription):
    return [woo_get(f"/orders/{oid}") for oid in renewal_order_ids(subscription)]


def verify_intents(order_ids_with_intents):
    """Ask Stripe which of these PaymentIntent ids are really succeeded."""
    verified = set()
    for intent_id in order_ids_with_intents:
        try:
            intent = stripe.PaymentIntent.retrieve(intent_id)
        except stripe.error.InvalidRequestError:
            continue
        if intent.status == "succeeded":
            verified.add(intent_id)
    return verified


def repair_counter(subscription_id, coupon_code, true_count):
    key = f"{COUNTER_META_PREFIX}{coupon_code.lower()}"
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"meta_data": [{"key": key, "value": str(true_count)}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Coupon '{coupon_code}' payment counter recounted from order history "
                      f"and corrected to {true_count}."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run(coupon_code):
    repaired = 0
    for subscription in subscriptions_with_coupon(coupon_code):
        renewals = get_renewal_orders(subscription)
        intent_ids = {intent_id_of(o) for o in renewals if intent_id_of(o)}
        verified = verify_intents(intent_ids)
        true_count = true_payment_count(renewals, coupon_code, verified)
        action, reason = decide(subscription, coupon_code, true_count)
        if action in ("skip", "unknown"):
            if action == "unknown":
                log.warning("Subscription %s: %s", subscription["id"], reason)
            continue
        log.info("Subscription %s: %s. %s", subscription["id"], reason,
                  "would repair" if DRY_RUN else "repairing")
        if not DRY_RUN:
            repair_counter(subscription["id"], coupon_code, true_count)
        repaired += 1
    log.info("Done. %d subscription(s) %s.", repaired, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run(os.environ.get("COUPON_CODE", "vip10"))
