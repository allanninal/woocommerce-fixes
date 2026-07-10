"""Find WooCommerce subscriptions that started on iDEAL or Bancontact and have
no reusable payment method on file before their next renewal date.

iDEAL and Bancontact are one off, redirect based methods. Stripe does not attach
a reusable payment method to the customer behind either one, so a subscription
stuck on one of them will fail its next automatic renewal unless a human asks
the customer to add a card first. Read only by default. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/ideal-and-bancontact-for-renewals/
"""
import os
import logging
from datetime import datetime, timedelta, timezone
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_one_off_methods")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
RENEWAL_WINDOW_DAYS = int(os.environ.get("RENEWAL_WINDOW_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ONE_OFF_METHOD_TYPES = {"ideal", "bancontact"}


def due_soon_subscriptions(window_days):
    """List active subscriptions whose next renewal falls inside window_days."""
    cutoff = datetime.now(timezone.utc) + timedelta(days=window_days)
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
            next_payment = sub.get("next_payment_date_gmt")
            if next_payment and datetime.fromisoformat(next_payment).replace(tzinfo=timezone.utc) <= cutoff:
                yield sub
        page += 1


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id, expand=["payment_method"])
    except stripe.error.InvalidRequestError:
        return None


def has_reusable_method(customer_id):
    if not customer_id:
        return False
    methods = stripe.PaymentMethod.list(customer=customer_id, type="card")
    return len(methods.data) > 0


def days_until(next_payment_date_gmt):
    when = datetime.fromisoformat(next_payment_date_gmt).replace(tzinfo=timezone.utc)
    return max(0, (when - datetime.now(timezone.utc)).days)


def decide(subscription, intent, has_reusable, days_until_renewal):
    """Pure decision function. No I/O. Returns (action, reason).

    action is one of "flag", "ok", "skip".
    """
    if intent is None:
        return ("skip", "no PaymentIntent found for the first order")
    method_types = set(intent.get("payment_method_types") or [])
    if not method_types & ONE_OFF_METHOD_TYPES:
        return ("skip", "first payment used a reusable method")
    if has_reusable:
        return ("ok", "a reusable card is already on file")
    if days_until_renewal > subscription.get("renewal_window_days", RENEWAL_WINDOW_DAYS):
        return ("skip", "renewal is not close enough yet")
    return ("flag", "one off method with no reusable card before renewal")


def flag_subscription(subscription_id, order_id, reason):
    note = (f"Renewal risk: {reason}. The first payment used a one off method "
            f"(iDEAL or Bancontact) and no reusable card is on file. "
            f"Ask the customer to add a card before the next renewal date.")
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{subscription_id}/notes",
        json={"note": note}, auth=AUTH, timeout=30,
    ).raise_for_status()
    if order_id and order_id != subscription_id:
        requests.post(
            f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
            json={"note": note}, auth=AUTH, timeout=30,
        ).raise_for_status()


def run():
    flagged = 0
    for sub in due_soon_subscriptions(RENEWAL_WINDOW_DAYS):
        parent_order_id = sub.get("parent_id") or sub["id"]
        order = get_order(parent_order_id)
        intent = get_intent(intent_id_of(order)) if order else None
        customer_id = intent.get("customer") if intent else None
        reusable = has_reusable_method(customer_id)
        remaining = days_until(sub["next_payment_date_gmt"])
        action, reason = decide(sub, intent, reusable, remaining)
        if action != "flag":
            continue
        log.warning("Subscription %s: %s. %s", sub["id"], reason, "would flag" if DRY_RUN else "flagging")
        if not DRY_RUN:
            flag_subscription(sub["id"], parent_order_id, reason)
        flagged += 1
    log.info("Done. %d subscription(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
