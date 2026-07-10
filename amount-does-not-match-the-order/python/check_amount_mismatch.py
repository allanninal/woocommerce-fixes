"""Flag WooCommerce orders whose total does not match the Stripe charge behind them.

A partial refund applied only on one side, a currency rounding difference, a coupon
that changed the order after the PaymentIntent was created, or a manual edit to the
order total can all leave the WooCommerce order total and the Stripe PaymentIntent
amount disagreeing. This walks recent paid orders, reads the saved PaymentIntent id
from order meta `_stripe_intent_id` (falling back to `transaction_id`), and flags any
order whose amount drifts from what Stripe actually captured, by adding an order note.
Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_amount_mismatch")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
MISMATCH_TOLERANCE_MINOR = int(os.environ.get("MISMATCH_TOLERANCE_MINOR", "1"))
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
    """Order total in minor units (cents). Two decimal currencies only; zero decimal
    currencies such as JPY have their own guide, since round(x * 100) is wrong there."""
    return round(float(order["total"]) * 100)


def captured_amount_minor(intent):
    """What Stripe actually captured for this intent, in minor units."""
    return intent.get("amount_received", intent.get("amount", 0))


def decide(order, intent, tolerance_minor=MISMATCH_TOLERANCE_MINOR):
    """Pure decision: given an order and its Stripe PaymentIntent, decide whether the
    amounts agree. No I/O here, so this is fully unit testable."""
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order not in a paid state")
    if intent is None:
        return ("skip", "no Stripe PaymentIntent id on this order")
    if intent.get("status") != "succeeded":
        return ("skip", "intent not succeeded, amount comparison does not apply yet")
    order_minor = order_amount_minor(order)
    charged_minor = captured_amount_minor(intent)
    drift = order_minor - charged_minor
    if abs(drift) <= tolerance_minor:
        return ("ok", "order total matches the captured amount")
    direction = "order total is higher than the Stripe charge" if drift > 0 else "order total is lower than the Stripe charge"
    return ("flag", f"amount does not match the order: {direction} (drift {drift} minor units)")


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
        json={"note": f"Payment check failed: {reason}. Please review before shipping "
                      f"or refunding this order."},
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
