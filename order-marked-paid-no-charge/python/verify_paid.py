"""Flag WooCommerce orders marked paid that have no matching succeeded Stripe charge.

An order can end up Processing or Completed without a real payment behind it: a
manual status change, a failed integration, or a tampered checkout. This walks recent
paid orders, looks up the saved Stripe PaymentIntent, and flags any order whose
payment is missing, not succeeded, or the wrong amount, by adding an order note (and
optionally moving it to on-hold for review). Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("verify_paid")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
REVIEW_HOLD = os.environ.get("REVIEW_HOLD", "false").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    return round(float(order["total"]) * 100)


def decide(order, intent):
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order not in a paid state")
    if intent is None:
        return ("flag", "no Stripe charge found for a paid order")
    if intent.get("status") != "succeeded":
        return ("flag", "Stripe shows the payment not succeeded")
    if abs(order_amount_minor(order) - intent.get("amount_received", 0)) > 1:
        return ("flag", "amount does not match the Stripe charge")
    return ("ok", "matches a succeeded Stripe charge")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def paid_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "processing,completed", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def flag(order, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Payment check failed: {reason}. This order is marked paid but "
                      f"Stripe does not confirm a matching succeeded charge. Please review."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    if REVIEW_HOLD:
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
            json={"status": "on-hold"}, auth=AUTH, timeout=30,
        ).raise_for_status()


def run():
    flagged = 0
    for order in paid_orders():
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent)
        if action != "flag":
            continue
        log.warning("Order %s: %s. %s", order["id"], reason, "would flag" if DRY_RUN else "flagging")
        if not DRY_RUN:
            flag(order, reason)
        flagged += 1
    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
