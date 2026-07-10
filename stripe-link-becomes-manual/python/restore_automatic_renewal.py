"""Restore automatic renewal on WooCommerce Subscriptions that a Stripe Link
checkout left on manual renewal, but only when Stripe now shows a genuine
reusable payment method for that customer. Run on a schedule. Safe to run
again and again.

Guide: https://www.allanninal.dev/woocommerce/stripe-link-becomes-manual/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restore_automatic_renewal")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

REUSABLE_TYPES = {"card", "us_bank_account", "sepa_debit"}


def manual_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            if sub.get("requires_manual_renewal"):
                yield sub
        page += 1


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def default_reusable_payment_method(customer_id):
    """The Stripe customer's default payment method, if it is a reusable type."""
    if not customer_id:
        return None
    try:
        customer = stripe.Customer.retrieve(customer_id)
    except stripe.error.InvalidRequestError:
        return None
    pm_id = (customer.get("invoice_settings") or {}).get("default_payment_method")
    if not pm_id:
        methods = stripe.PaymentMethod.list(customer=customer_id, limit=1)
        if not methods.data:
            return None
        pm_id = methods.data[0].id
    try:
        return stripe.PaymentMethod.retrieve(pm_id)
    except stripe.error.InvalidRequestError:
        return None


def is_reusable(payment_method):
    """A payment method Stripe will let us charge again off session."""
    if not payment_method:
        return False
    return payment_method.get("type") in REUSABLE_TYPES


def decide(subscription, payment_method):
    """Pure decision: no I/O, only plain dicts in, an action tuple out."""
    if not subscription.get("requires_manual_renewal"):
        return ("skip", "subscription already automatic")
    if subscription.get("payment_method") not in ("stripe", ""):
        return ("skip", "not billed through the Stripe gateway")
    if not is_reusable(payment_method):
        return ("keep_manual", "no reusable payment method on the Stripe customer")
    return ("repair", "reusable payment method found, safe to re-enable automatic renewal")


def re_enable_automatic(subscription_id, parent_order_id, payment_method):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"requires_manual_renewal": False, "payment_method": "stripe"},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{parent_order_id}/notes",
        json={"note": f"Automatic renewal restored. Stripe customer now has a reusable "
                      f"{payment_method['type']} payment method on file, so the Link "
                      f"checkout fallback to manual renewal was cleared by the repair job."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repaired = 0
    for sub in manual_subscriptions():
        parent_order_id = sub.get("parent_id")
        order = get_order(parent_order_id) if parent_order_id else None
        payment_method = None
        if order:
            intent = get_intent(intent_id_of(order))
            customer_id = intent.get("customer") if intent else None
            payment_method = default_reusable_payment_method(customer_id)
        action, reason = decide(sub, payment_method)
        if action != "repair":
            if action == "keep_manual":
                log.info("Subscription %s: %s", sub["id"], reason)
            continue
        log.info("Subscription %s: %s. %s", sub["id"], reason, "would repair" if DRY_RUN else "repairing")
        if not DRY_RUN:
            re_enable_automatic(sub["id"], parent_order_id, payment_method)
        repaired += 1
    log.info("Done. %d subscription(s) %s.", repaired, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
