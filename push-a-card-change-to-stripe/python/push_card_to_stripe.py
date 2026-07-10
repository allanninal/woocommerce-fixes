"""Push a WooCommerce card change to the Stripe customer's default payment method.

A shopper updates their card on a WooCommerce order (or through My Account, Change
payment method) and the new card is charged just fine on that one order. But the
Stripe customer record is never told the card changed, so `invoice_settings.
default_payment_method` still points at the old card. The next Stripe Billing renewal,
or the next off-session charge, reaches for the old card and fails.

This walks recent paid orders, reads the PaymentIntent saved on each one, and pushes
its payment method onto the Stripe customer as the new default whenever it differs
from what Stripe already has on file. Safe to run again and again. Dry run by default.

Guide: https://www.allanninal.dev/woocommerce/push-a-card-change-to-stripe/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("push_card_to_stripe")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
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
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(order["total"]) * 100)


def decide(order, intent, customer):
    """Pure decision function. No I/O. Returns (action, reason).

    Actions: skip, orphan, mismatch, push, already-synced.
    """
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order not in a paid state")
    if intent is None:
        return ("orphan", "no PaymentIntent saved on this order")
    if intent.get("status") != "succeeded":
        return ("skip", "intent not succeeded")
    if not intent.get("payment_method"):
        return ("orphan", "intent has no payment_method attached")
    if abs(order_amount_minor(order) - intent.get("amount_received", 0)) > 1:
        return ("mismatch", "amount does not match the order, skipping to be safe")
    if customer is None:
        return ("orphan", "no Stripe customer found for this order")
    current_default = (customer.get("invoice_settings") or {}).get("default_payment_method")
    if current_default == intent["payment_method"]:
        return ("already-synced", "Stripe default payment method already matches")
    return ("push", "order paid with a card Stripe does not have as the default yet")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def get_customer(customer_id):
    if not customer_id:
        return None
    try:
        return stripe.Customer.retrieve(customer_id)
    except stripe.error.InvalidRequestError:
        return None


def customer_id_of(order):
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_customer_id" and meta.get("value"):
            return meta["value"]
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


def push_default(customer_id, payment_method_id):
    # Make sure the payment method is attached to this customer before it can be
    # set as the default. Attaching an already attached payment method is a no-op.
    try:
        stripe.PaymentMethod.attach(payment_method_id, customer=customer_id)
    except stripe.error.InvalidRequestError as err:
        if "already been attached" not in str(err):
            raise
    stripe.Customer.modify(
        customer_id,
        invoice_settings={"default_payment_method": payment_method_id},
    )


def note_order(order_id, payment_method_id):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Pushed the new card to Stripe as the default payment method "
                      f"({payment_method_id}). Future renewals will use this card."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    pushed = 0
    for order in paid_orders():
        intent = get_intent(intent_id_of(order))
        customer_id = customer_id_of(order)
        customer = get_customer(customer_id)
        action, reason = decide(order, intent, customer)
        if action in ("skip", "already-synced"):
            continue
        if action == "orphan":
            log.warning("Order %s: %s", order["id"], reason)
            continue
        if action == "mismatch":
            log.warning("Order %s: %s", order["id"], reason)
            continue
        payment_method_id = intent["payment_method"]
        log.info("Order %s: %s. %s", order["id"], reason, "would push" if DRY_RUN else "pushing")
        if not DRY_RUN:
            push_default(customer_id, payment_method_id)
            note_order(order["id"], payment_method_id)
        pushed += 1
    log.info("Done. %d order(s) %s.", pushed, "to push" if DRY_RUN else "pushed")


if __name__ == "__main__":
    run()
