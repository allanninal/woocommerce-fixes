"""Line up a WooCommerce order total with a partial Stripe capture.

A store on manual capture can capture less than the full authorized amount, for a
split shipment, a stock shortfall, or a deliberate partial charge. Stripe's
PaymentIntent then shows the real amount taken in `amount_received`, but the
WooCommerce order was created with the original, larger total and nothing updates
it. The order overstates what the buyer actually paid. This walks recent paid
orders, reads the saved Stripe PaymentIntent id from order meta
`_stripe_intent_id` (falling back to `transaction_id`), and for any order whose
total is higher than what Stripe actually captured, corrects the order total to
match and adds a note explaining the change. Safe by default, dry run first.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync_partial_capture")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
MISMATCH_TOLERANCE_MINOR = int(os.environ.get("MISMATCH_TOLERANCE_MINOR", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_total_minor(order):
    """Order total in minor units (cents). Two decimal currencies only; zero decimal
    currencies such as JPY have their own guide, since round(x * 100) is wrong there."""
    return round(float(order["total"]) * 100)


def captured_minor(intent):
    """What Stripe actually captured for this intent, in minor units."""
    return intent.get("amount_received", 0)


def to_major_str(minor):
    """Minor units back to a two decimal string suitable for a WooCommerce total."""
    return f"{minor / 100:.2f}"


def decide(order, intent, tolerance_minor=MISMATCH_TOLERANCE_MINOR):
    """Pure decision: given an order and its Stripe PaymentIntent, decide whether the
    order total needs to be brought down to the amount Stripe actually captured.
    No I/O here, so this is fully unit testable.
    """
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order not in a paid state")
    if intent is None:
        return ("skip", "no Stripe PaymentIntent id on this order")
    if intent.get("status") not in ("succeeded", "requires_capture"):
        return ("skip", "intent has no capture to compare yet")
    if intent.get("amount_capturable", 0) > 0:
        return ("skip", "capture is still partial in progress, more may be captured")

    order_minor = order_total_minor(order)
    charged_minor = captured_minor(intent)
    drift = order_minor - charged_minor

    if abs(drift) <= tolerance_minor:
        return ("ok", "order total matches what Stripe captured")
    if drift < 0:
        # Order total is lower than what Stripe took. That is an overcharge, not a
        # partial capture, and deserves its own careful look rather than an auto-fix.
        return ("flag", f"order total is lower than the Stripe charge (drift {drift} minor units)")

    return (
        "fix",
        f"only {charged_minor} of {order_minor} minor units was captured, "
        f"order total should drop to match",
    )


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


def apply_fix(order, intent, reason):
    new_total = to_major_str(captured_minor(intent))
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"total": new_total},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Total corrected for a partial capture: {reason}. "
                      f"Order total set to {new_total} to match Stripe PaymentIntent "
                      f"{intent['id']}. Please review line items if this needs a refund too."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def flag(order, intent, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Capture check failed: {reason}. PaymentIntent "
                      f"{intent['id']}. Please review before shipping or refunding."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    flagged = 0
    for order in paid_orders():
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent)
        if action == "skip":
            continue
        if action == "flag":
            log.warning("Order %s: %s. %s", order["id"], reason, "would flag" if DRY_RUN else "flagging")
            if not DRY_RUN:
                flag(order, intent, reason)
            flagged += 1
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would fix" if DRY_RUN else "fixing")
        if not DRY_RUN:
            apply_fix(order, intent, reason)
        fixed += 1
    log.info(
        "Done. %d order(s) %s, %d order(s) %s.",
        fixed, "to fix" if DRY_RUN else "fixed",
        flagged, "to flag" if DRY_RUN else "flagged",
    )


if __name__ == "__main__":
    run()
