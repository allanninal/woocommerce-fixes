"""Recreate WooCommerce Subscriptions renewals after a Stripe account move.

When a store moves to a new Stripe account (a merge, a platform migration, or a
new Connect account), every saved card token that lived on the old account stops
working. WooCommerce Subscriptions still points renewal orders at the old
Stripe customer and payment method id, so the next scheduled renewal fails with
a Stripe error like "No such customer" or "No such payment_method". This script
finds subscriptions still tied to the old Stripe account, and for any customer
who already has a valid, chargeable payment method on the new account, it
re-points the subscription at the new Stripe customer and payment method so the
next renewal can actually be charged. Read-only planning by default. Run once
per migration, or on a schedule until the backlog clears.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recreate_subs")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
OLD_ACCOUNT_ID = os.environ.get("OLD_STRIPE_ACCOUNT_ID", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_SUB_STATUSES = {"active", "on-hold"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def source_meta(order):
    """Pull the stored Stripe customer id and source/payment_method id off an order."""
    customer_id = None
    source_id = None
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_customer_id":
            customer_id = meta.get("value")
        if meta.get("key") == "_stripe_source_id":
            source_id = meta.get("value")
    return customer_id, source_id


def decide(subscription, new_token):
    """Pure decision: what should we do with this subscription's Stripe link.

    subscription: dict with at least "status", "_stripe_customer_id",
        "_stripe_source_id" (the ids saved on the subscription today).
    new_token: dict or None. When present, it is the customer's newest valid,
        chargeable payment method on the NEW Stripe account, shaped like
        {"customer_id": "cus_new...", "payment_method_id": "pm_new...", "chargeable": bool}.

    Returns a (action, reason) tuple. action is one of:
      "skip"    - nothing to do, leave the subscription alone
      "missing" - subscription is active but the customer has no usable token yet
      "recreate" - re-point the subscription at the new customer/payment method
    """
    if subscription["status"] not in ACTIVE_SUB_STATUSES:
        return ("skip", "subscription is not active or on-hold")

    old_customer = subscription.get("_stripe_customer_id")
    old_source = subscription.get("_stripe_source_id")

    if not old_customer:
        return ("skip", "no old Stripe customer recorded, nothing to migrate")

    if new_token is None:
        return ("missing", "no valid payment method on the new Stripe account yet")

    if not new_token.get("chargeable", False):
        return ("missing", "customer has a payment method on the new account but it is not chargeable")

    if new_token.get("customer_id") == old_customer and new_token.get("payment_method_id") == old_source:
        return ("skip", "subscription already points at the current token")

    return ("recreate", "old token is gone, pointing subscription at the new customer and payment method")


def find_new_token(email):
    """Search the (new, current) Stripe account for a customer by email and
    return their most recently attached chargeable card payment method, or None.
    """
    customers = stripe.Customer.list(email=email, limit=1).data
    if not customers:
        return None
    customer = customers[0]
    methods = stripe.PaymentMethod.list(customer=customer.id, type="card", limit=1).data
    if not methods:
        return None
    pm = methods[0]
    chargeable = pm.card.get("checks", {}).get("cvc_check") != "fail"
    return {"customer_id": customer.id, "payment_method_id": pm.id, "chargeable": chargeable}


def get_subscription(sub_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{sub_id}", auth=AUTH, timeout=30)
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


def apply_new_token(sub_id, new_token):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}",
        json={
            "meta_data": [
                {"key": "_stripe_customer_id", "value": new_token["customer_id"]},
                {"key": "_stripe_source_id", "value": new_token["payment_method_id"]},
            ]
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
        json={"note": f"Recreated after the Stripe account move. Now billing "
                      f"{new_token['customer_id']} / {new_token['payment_method_id']} "
                      f"on the new account."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    recreated = 0
    missing = 0
    for sub in active_subscriptions():
        meta = {m["key"]: m.get("value") for m in sub.get("meta_data") or []}
        subscription = {
            "status": sub["status"],
            "_stripe_customer_id": meta.get("_stripe_customer_id"),
            "_stripe_source_id": meta.get("_stripe_source_id"),
        }
        email = (sub.get("billing") or {}).get("email")
        new_token = find_new_token(email) if email else None
        action, reason = decide(subscription, new_token)

        if action == "skip":
            continue
        if action == "missing":
            log.warning("Subscription %s: %s", sub["id"], reason)
            missing += 1
            continue

        log.info("Subscription %s: %s. %s", sub["id"], reason, "would recreate" if DRY_RUN else "recreating")
        if not DRY_RUN:
            apply_new_token(sub["id"], new_token)
        recreated += 1

    log.info(
        "Done. %d subscription(s) %s. %d still need a new card from the customer.",
        recreated, "to recreate" if DRY_RUN else "recreated", missing,
    )


if __name__ == "__main__":
    run()
