"""Restore automatic renewal for SEPA subscriptions an update flipped to manual.

An update can change how WooCommerce Subscriptions checks for a saved SEPA Direct
Debit token, so it sets requires_manual_renewal even though the mandate is still
attached in Stripe. This walks active subscriptions on manual renewal, checks Stripe
for a real attached and enabled SEPA PaymentMethod, and restores automatic renewal
for the ones that have one. Never triggers a charge. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/sepa-subs-flip-to-manual-renewal/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restore_sepa_renewal")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def manual_renewal_subs():
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


def customer_id_of(subscription):
    """The saved Stripe customer id, from subscription meta _stripe_customer_id."""
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_customer_id" and meta.get("value"):
            return meta["value"]
    return None


def active_sepa_payment_method(customer_id):
    """The first attached, non-disabled SEPA Direct Debit PaymentMethod on the customer."""
    if not customer_id:
        return None
    methods = stripe.PaymentMethod.list(customer=customer_id, type="sepa_debit")
    for pm in methods.auto_paging_iter():
        if pm.customer and pm.get("sepa_debit") and not pm.get("disabled"):
            return pm
    return None


def decide(subscription, payment_method):
    """Pure decision: does this subscription need automatic renewal restored.

    subscription: dict with at least "status" and "requires_manual_renewal".
    payment_method: a Stripe PaymentMethod-like dict (or None) with "sepa_debit"
        and optionally "disabled".
    Returns a (action, reason) tuple. action is one of "skip", "hold", "repair".
    """
    if subscription.get("status") != "active":
        return ("skip", "subscription is not active")
    if not subscription.get("requires_manual_renewal"):
        return ("skip", "already on automatic renewal")
    if payment_method is None:
        return ("hold", "no attached SEPA mandate found, leaving on manual renewal")
    if payment_method.get("disabled"):
        return ("hold", "SEPA mandate found but marked disabled")
    return ("repair", "SEPA mandate is attached and enabled, restoring automatic renewal")


def restore_automatic_renewal(subscription_id, payment_method):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={
            "requires_manual_renewal": False,
            "meta_data": [
                {"key": "_payment_method", "value": "stripe_sepa"},
                {"key": "_payment_method_title", "value": "SEPA Direct Debit"},
                {"key": "_stripe_source_id", "value": payment_method["id"]},
            ],
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Automatic renewal restored. Stripe confirms SEPA PaymentMethod "
                      f"{payment_method['id']} is still attached and enabled. Repaired by script."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repaired = 0
    for sub in manual_renewal_subs():
        customer_id = customer_id_of(sub)
        pm = active_sepa_payment_method(customer_id)
        action, reason = decide(sub, pm)
        if action == "skip":
            continue
        if action == "hold":
            log.warning("Subscription %s: %s", sub["id"], reason)
            continue
        log.info("Subscription %s: %s. %s", sub["id"], reason, "would repair" if DRY_RUN else "repairing")
        if not DRY_RUN:
            restore_automatic_renewal(sub["id"], pm)
        repaired += 1
    log.info("Done. %d subscription(s) %s.", repaired, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
