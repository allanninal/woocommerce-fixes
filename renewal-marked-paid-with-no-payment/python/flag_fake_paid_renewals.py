"""Flag WooCommerce Subscriptions renewal orders marked paid with no matching
Stripe charge behind them.

A caching bug or a race between two renewal attempts can let the renewal
handler take its success path, marking the order paid and extending the
subscription, without a succeeded PaymentIntent ever existing in Stripe. This
walks recent renewal orders, looks up the saved PaymentIntent, and flags any
renewal whose payment is missing, not succeeded, or the wrong amount, by
adding an order note (and optionally moving it to on-hold for review). Read
only by default. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/renewal-marked-paid-with-no-payment/
"""
import os
import datetime
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_fake_paid_renewals")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
REVIEW_HOLD = os.environ.get("REVIEW_HOLD", "false").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def is_renewal(order):
    """True when the order carries the WooCommerce Subscriptions renewal meta key."""
    return any(m.get("key") == "_subscription_renewal" for m in order.get("meta_data") or [])


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    """Order total in cents. Two decimal currencies only; zero decimal
    currencies (JPY and friends) need a separate conversion and are out of
    scope for this script."""
    return round(float(order["total"]) * 100)


def decide(order, intent):
    """Pure decision: does this renewal order need to be flagged?

    order: a dict shaped like the WooCommerce REST API order resource.
    intent: a dict shaped like a Stripe PaymentIntent, or None if none was found.
    Returns a tuple of (action, reason) where action is one of
    "skip", "flag", or "ok".
    """
    if order["status"] not in PAID_STATUSES:
        return ("skip", "renewal not in a paid state")
    if intent is None:
        return ("flag", "no Stripe charge found for a paid renewal")
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


def paid_renewal_orders():
    after = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat() + "T00:00:00"
    page = 1
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
            if is_renewal(order):
                yield order
        page += 1


def flag(order, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Renewal payment check failed: {reason}. This renewal is marked paid "
                      f"but Stripe does not confirm a matching succeeded charge. Please review."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    if REVIEW_HOLD:
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
            json={"status": "on-hold"}, auth=AUTH, timeout=30,
        ).raise_for_status()


def run():
    flagged = 0
    for order in paid_renewal_orders():
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent)
        if action != "flag":
            continue
        log.warning("Renewal %s: %s. %s", order["id"], reason, "would flag" if DRY_RUN else "flagging")
        if not DRY_RUN:
            flag(order, reason)
        flagged += 1
    log.info("Done. %d renewal(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
