"""Attach a valid off session mandate to old WooCommerce Subscriptions orders.

Subscriptions created before Strong Customer Authentication (SCA) became the norm
often saved a card as a plain Stripe Source, or as a PaymentMethod that was only
ever confirmed on session (the shopper was on the checkout page). Stripe requires
an off session mandate before it will let a merchant charge a saved PaymentMethod
without the customer present. Without one, the renewal PaymentIntent comes back
with status requires_action and the subscription goes on-hold.

This walks active subscriptions, reads the saved PaymentMethod from the parent
order, and for any PaymentMethod that has never completed an off session
confirmation, runs a zero amount off session SetupIntent to attach a mandate.
That mandate is then reused by every future renewal. Read only by default
(DRY_RUN=true). Safe to run again and again, since a PaymentMethod that already
has a mandate is left alone.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("attach_off_session_mandate")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_SUB_STATUSES = {"active", "on-hold"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(subscription, payment_method):
    """Pure decision. No network calls in here, so it is easy to unit test.

    subscription: dict with at least {"id", "status"}
    payment_method: dict shaped like a Stripe PaymentMethod, or None. May carry
                     a custom field "off_session_mandate" (str or None) that the
                     caller reads from payment_method.metadata or an attached
                     mandate id, since the raw Stripe object does not expose a
                     simple boolean for "has an off session mandate".
    """
    if subscription["status"] not in ACTIVE_SUB_STATUSES:
        return ("skip", "subscription is not active or on-hold")
    if payment_method is None:
        return ("no_payment_method", "no saved PaymentMethod on the parent order")
    if payment_method.get("type") not in ("card", "sepa_debit", "us_bank_account"):
        return ("skip", "payment method type does not support an off session mandate")
    if payment_method.get("off_session_mandate"):
        return ("ok", "already has an off session mandate")
    return ("attach_mandate", "no off session mandate found, needs one before the next renewal")


def order_amount_minor(order):
    return round(float(order["total"]) * 100)


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


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


def get_payment_method(order):
    """Look up the Stripe PaymentMethod behind the order's saved PaymentIntent."""
    intent_id = intent_id_of(order)
    if not intent_id:
        return None
    intent = stripe.PaymentIntent.retrieve(intent_id)
    pm_id = intent.get("payment_method")
    if not pm_id:
        return None
    pm = stripe.PaymentMethod.retrieve(pm_id)
    # Stripe has no single boolean for "has an off session mandate". We treat a
    # PaymentMethod as already covered when it is attached to a customer and a
    # prior off session SetupIntent succeeded for it. We fetch that by listing
    # SetupIntents for the customer and checking usage and payment_method match.
    pm["off_session_mandate"] = _existing_mandate(pm)
    return pm


def _existing_mandate(pm):
    customer_id = pm.get("customer")
    if not customer_id:
        return None
    setup_intents = stripe.SetupIntent.list(customer=customer_id, limit=20)
    for si in setup_intents.auto_paging_iter():
        if (
            si.get("payment_method") == pm["id"]
            and si.get("usage") == "off_session"
            and si.get("status") == "succeeded"
        ):
            return si["id"]
    return None


def attach_mandate(order, payment_method):
    """Confirm a zero amount off session SetupIntent to record a mandate."""
    setup_intent = stripe.SetupIntent.create(
        customer=payment_method["customer"],
        payment_method=payment_method["id"],
        usage="off_session",
        confirm=True,
        off_session=True,
    )
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Attached an off session mandate to PaymentMethod {payment_method['id']} "
                      f"via SetupIntent {setup_intent['id']}. Future renewals can now charge "
                      f"this card without the customer present."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    return setup_intent


def run():
    attached = 0
    for sub in active_subscriptions():
        parent_order_id = sub.get("parent_id") or sub["id"]
        order = get_order(parent_order_id)
        if order is None:
            log.warning("Subscription %s has no matching parent order %s", sub["id"], parent_order_id)
            continue
        payment_method = get_payment_method(order)
        action, reason = decide(sub, payment_method)
        if action in ("skip", "ok"):
            continue
        if action == "no_payment_method":
            log.warning("Subscription %s: %s", sub["id"], reason)
            continue
        log.info("Subscription %s: %s. %s", sub["id"], reason, "would attach" if DRY_RUN else "attaching")
        if not DRY_RUN:
            attach_mandate(order, payment_method)
        attached += 1
    log.info("Done. %d subscription(s) %s.", attached, "need a mandate" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
