"""Attach a WooCommerce customer's saved Stripe PaymentMethod to their Stripe
Customer when it exists but was never attached. Run on a schedule, ahead of
billing. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/attach-the-payment-method/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("attach_payment_method")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def payment_method_id_of(order):
    """The saved Stripe PaymentIntent id lives on meta _stripe_intent_id.
    We use it to look up the PaymentIntent, then read payment_method off it.
    Some older orders only have a pm_ id directly on transaction_id.
    """
    tid = order.get("transaction_id") or ""
    if tid.startswith("pm_"):
        return tid
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    return None


def stripe_customer_id_of(wc_customer_id):
    if not wc_customer_id:
        return None
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/customers/{wc_customer_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    for meta in r.json().get("meta_data") or []:
        if meta.get("key") == "_stripe_customer_id":
            return meta.get("value")
    return None


def resolve_payment_method(raw_id):
    """Turn whatever id we found (a pi_... or a pm_...) into a PaymentMethod
    object read straight from Stripe. Returns None if it cannot be resolved.
    """
    if raw_id is None:
        return None
    try:
        if raw_id.startswith("pi_"):
            intent = stripe.PaymentIntent.retrieve(raw_id)
            pm_id = intent.get("payment_method")
            return stripe.PaymentMethod.retrieve(pm_id) if pm_id else None
        return stripe.PaymentMethod.retrieve(raw_id)
    except stripe.error.InvalidRequestError:
        return None


def decide(stripe_customer_id, payment_method):
    """Pure decision function. No I/O. Takes the Stripe Customer id the
    WooCommerce customer should be linked to, and the PaymentMethod object
    (a plain dict-like with a "customer" field) as read from Stripe, and
    returns (action, reason).

    Actions:
      skip     - nothing to check or nothing to compare against
      ok       - already attached to the expected customer, no change needed
      conflict - attached to a different customer, needs a human to review
      attach   - unattached, safe to attach automatically
    """
    if payment_method is None:
        return ("skip", "no PaymentMethod found to check")
    if not stripe_customer_id:
        return ("skip", "customer has no Stripe Customer id on file")
    current = payment_method.get("customer")
    if current == stripe_customer_id:
        return ("ok", "already attached to the right customer")
    if current:
        return ("conflict", f"attached to a different customer ({current})")
    return ("attach", "unattached, safe to attach")


def attach_payment_method(payment_method_id, stripe_customer_id):
    stripe.PaymentMethod.attach(payment_method_id, customer=stripe_customer_id)


def add_note(order_id, note):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": note}, auth=AUTH, timeout=30,
    ).raise_for_status()


def recent_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def run():
    fixed = 0
    for order in recent_orders():
        raw_id = payment_method_id_of(order)
        if raw_id is None:
            continue
        payment_method = resolve_payment_method(raw_id)
        stripe_customer_id = stripe_customer_id_of(order.get("customer_id"))
        action, reason = decide(stripe_customer_id, payment_method)
        if action == "conflict":
            log.warning("Order %s: %s. Needs a human to review.", order["id"], reason)
            continue
        if action in ("skip", "ok"):
            continue
        pm_id = payment_method["id"]
        log.info("Order %s: %s. %s", order["id"], reason, "would attach" if DRY_RUN else "attaching")
        if not DRY_RUN:
            attach_payment_method(pm_id, stripe_customer_id)
            add_note(
                order["id"],
                f"Attached Stripe PaymentMethod {pm_id} to Stripe Customer "
                f"{stripe_customer_id}. It existed but was not attached, which "
                f"would have blocked the next off session charge.",
            )
        fixed += 1
    log.info("Done. %d PaymentMethod(s) %s.", fixed, "to attach" if DRY_RUN else "attached")


if __name__ == "__main__":
    run()
