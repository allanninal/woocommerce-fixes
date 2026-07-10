"""Find WooCommerce subscriptions whose first payment succeeded but never
saved a reusable card, so the next automatic renewal has nothing to charge.

The initial order can be paid in full while the Stripe PaymentIntent behind it
was created without `setup_future_usage`. That happens when a checkout plugin,
a custom "buy now" button, or an older integration builds the PaymentIntent by
hand and forgets the flag. Stripe still takes the money, WooCommerce still
marks the order paid, and nobody notices until the renewal date arrives with
no saved card to charge.

This walks active and on-hold subscriptions, reads the PaymentIntent id from
the parent order's meta (_stripe_intent_id, falling back to transaction_id),
and asks Stripe whether that PaymentIntent actually attached a reusable
PaymentMethod to a Customer. If it did not, there is nothing to recover, so the
subscription is flagged (and optionally put on-hold) well before the renewal
is due, so the shop can ask the customer for a card while there is still time.
Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_unsaved_renewal_cards")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DAYS_BEFORE_RENEWAL = int(os.environ.get("DAYS_BEFORE_RENEWAL", "3"))
REVIEW_HOLD = os.environ.get("REVIEW_HOLD", "false").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_STATUSES = {"active", "on-hold"}


def get_meta(record, key):
    for m in (record or {}).get("meta_data", []) or []:
        if m.get("key") == key:
            return m.get("value")
    return None


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    value = get_meta(order, "_stripe_intent_id")
    if value:
        return value
    tid = (order or {}).get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def days_until(renewal_date_gmt, now):
    if not renewal_date_gmt:
        return None
    from datetime import datetime, timezone
    renewal = datetime.fromisoformat(renewal_date_gmt.replace("Z", "+00:00"))
    if renewal.tzinfo is None:
        renewal = renewal.replace(tzinfo=timezone.utc)
    return (renewal - now).total_seconds() / 86400


def decide(subscription, parent_order, intent, now):
    """Pure decision function. No I/O.

    subscription: dict with at least "id", "status", "next_payment_date_gmt".
    parent_order: the subscription's original paid order dict, or None.
    intent: the Stripe PaymentIntent dict the parent order paid with, or None
            if it could not be found on Stripe at all.
    now: a timezone-aware datetime, passed in so this stays pure.
    """
    if subscription["status"] not in ACTIVE_STATUSES:
        return ("skip", "subscription is not active or on-hold")
    if subscription.get("payment_method") != "stripe":
        return ("skip", "subscription is not on the Stripe gateway")
    remaining = days_until(subscription.get("next_payment_date_gmt"), now)
    if remaining is not None and remaining > DAYS_BEFORE_RENEWAL:
        return ("skip", "next renewal is not due soon enough to act yet")
    if parent_order is None:
        return ("skip", "no parent order to check yet")
    if intent is None:
        return ("skip", "parent order has no Stripe PaymentIntent to check")
    if intent.get("status") != "succeeded":
        return ("skip", "parent order payment was not a succeeded charge")
    if intent.get("customer") and intent.get("payment_method"):
        return ("ok", "a reusable card is already attached for renewals")
    return ("flag", "payment succeeded but no reusable card was saved for renewals")


def active_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active,on-hold", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            yield sub
        page += 1


def get_order(order_id):
    if not order_id:
        return None
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def flag(subscription, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription['id']}/notes",
        json={"note": f"Renewal card check failed: {reason}. The next automatic "
                      f"renewal will not have a card to charge. Please ask the "
                      f"customer to add a payment method before the renewal date."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    if REVIEW_HOLD:
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription['id']}",
            json={"status": "on-hold"}, auth=AUTH, timeout=30,
        ).raise_for_status()


def run():
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    flagged = 0
    for subscription in active_subscriptions():
        parent_order = get_order(subscription.get("parent_id"))
        intent = get_intent(intent_id_of(parent_order))
        action, reason = decide(subscription, parent_order, intent, now)
        if action != "flag":
            continue
        log.warning("Subscription %s: %s. %s", subscription["id"], reason,
                    "would flag" if DRY_RUN else "flagging")
        if not DRY_RUN:
            flag(subscription, reason)
        flagged += 1
    log.info("Done. %d subscription(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
