"""Find WooCommerce subscriptions whose saved Stripe payment method was detached.

A saved card lives on Stripe as a PaymentMethod attached to a Customer. If that
PaymentMethod gets detached, by the shopper removing it in a self-service portal,
by a cleanup script that ran against the wrong customer, or by a support agent
clearing "duplicate" cards, the next renewal fails with a generic decline and the
subscription goes on-hold. Stripe will not let you reattach a PaymentMethod once it
is detached, so there is nothing to repair automatically. This script only detects
the problem and flags the subscription so a human can ask the shopper for a new card.

It walks subscriptions that are active or on-hold, reads the PaymentIntent id from
the latest renewal order's meta (_stripe_intent_id, falling back to transaction_id),
asks Stripe for the payment_method that PaymentIntent tried to use, and checks
whether that PaymentMethod is still attached to the subscription's Stripe customer.
Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_detached_payment_methods")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_STATUSES = {"active", "on-hold"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(subscription, renewal_order, payment_method):
    """Pure decision function. No I/O.

    subscription: dict with at least "id" and "status".
    renewal_order: the subscription's most recent renewal order dict, or None
                    if there is no renewal order yet.
    payment_method: the Stripe PaymentMethod dict the renewal tried to charge,
                     or None if it could not be found on Stripe at all.
    """
    if subscription["status"] not in ACTIVE_STATUSES:
        return ("skip", "subscription is not active or on-hold")
    if renewal_order is None:
        return ("skip", "no renewal order to check yet")
    if intent_id_of(renewal_order) is None:
        return ("skip", "renewal order has no saved PaymentIntent id")
    if payment_method is None:
        return ("flag", "saved payment method no longer exists on Stripe")
    if payment_method.get("customer") is None:
        return ("flag", "payment method is detached from any Stripe customer")
    expected_customer = subscription.get("stripe_customer_id")
    if expected_customer and payment_method["customer"] != expected_customer:
        return ("flag", "payment method is attached to a different Stripe customer")
    return ("ok", "payment method is attached and matches the subscription")


def get_payment_method_for_intent(intent_id):
    """Look up the PaymentMethod a PaymentIntent tried to charge, if any."""
    if not intent_id:
        return None
    try:
        intent = stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None
    pm_id = intent.get("payment_method") or (
        intent.get("last_payment_error") or {}
    ).get("payment_method", {}).get("id")
    if not pm_id:
        return None
    try:
        return stripe.PaymentMethod.retrieve(pm_id)
    except stripe.error.InvalidRequestError:
        return None


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


def latest_renewal_order(subscription_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"subscription_renewal": subscription_id, "per_page": 1, "orderby": "date", "order": "desc"},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    batch = r.json()
    return batch[0] if batch else None


def flag(subscription, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{subscription['id']}/notes",
        json={"note": f"Payment method check failed: {reason}. The saved card can no "
                      f"longer be charged automatically. Please ask the customer to "
                      f"add a new payment method."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{subscription['id']}",
        json={"status": "on-hold"}, auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    flagged = 0
    for subscription in active_subscriptions():
        renewal_order = latest_renewal_order(subscription["id"])
        intent_id = intent_id_of(renewal_order) if renewal_order else None
        payment_method = get_payment_method_for_intent(intent_id)
        action, reason = decide(subscription, renewal_order, payment_method)
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
