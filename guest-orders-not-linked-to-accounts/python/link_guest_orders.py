"""Link guest WooCommerce orders to the account that shares the same email.

A guest checkout never sets order.customer_id, even when the billing email
matches a real, registered customer. The order sits at customer_id 0 forever,
so it never shows up in "My account", loyalty points never accrue, and any
per-customer report undercounts that shopper. This walks recent guest orders,
looks up a customer by billing email through the WooCommerce REST API, and
confirms the order was really paid by checking the saved Stripe PaymentIntent
before relinking it. Safe to run again and again. Dry run by default.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("link_guest_orders")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
REQUIRE_PAID = os.environ.get("REQUIRE_PAID", "true").lower() == "true"
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
    return round(float(order["total"]) * 100)


def decide(order, customers, intent=None):
    """Pure decision. customers is the list returned for the billing email lookup."""
    if order.get("customer_id", 0):
        return ("skip", "order is already linked to an account")
    email = (order.get("billing") or {}).get("email")
    if not email:
        return ("skip", "no billing email on the order")
    if REQUIRE_PAID and order["status"] not in PAID_STATUSES:
        return ("skip", "order is not paid yet")
    if not customers:
        return ("no_account", "no registered account uses this email")
    if len(customers) > 1:
        return ("ambiguous", "more than one account uses this email")
    if REQUIRE_PAID:
        if intent is None:
            return ("unverified", "no Stripe PaymentIntent saved on the order")
        if intent.get("status") != "succeeded":
            return ("unverified", "Stripe does not show this payment as succeeded")
        if abs(order_amount_minor(order) - intent.get("amount_received", 0)) > 1:
            return ("unverified", "order total does not match the Stripe charge")
    return ("link", f"billing email matches account {customers[0]['id']}")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def find_customers_by_email(email):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/customers",
        params={"email": email, "per_page": 10},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def guest_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"customer": 0, "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def link_order(order_id, customer_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"customer_id": customer_id},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Linked this guest order to account {customer_id} because the "
                      f"billing email matched a registered customer. Linked by the reconciler."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    linked = 0
    for order in guest_orders():
        email = (order.get("billing") or {}).get("email")
        customers = find_customers_by_email(email) if email else []
        intent = get_intent(intent_id_of(order)) if REQUIRE_PAID else None
        action, reason = decide(order, customers, intent)
        if action == "link":
            customer_id = customers[0]["id"]
            log.info("Order %s: %s. %s", order["id"], reason, "would link" if DRY_RUN else "linking")
            if not DRY_RUN:
                link_order(order["id"], customer_id)
            linked += 1
        elif action in ("ambiguous", "unverified"):
            log.warning("Order %s not linked: %s", order["id"], reason)
    log.info("Done. %d order(s) %s.", linked, "to link" if DRY_RUN else "linked")


if __name__ == "__main__":
    run()
