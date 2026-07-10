"""Find WooCommerce Subscriptions stuck on a stale saved card and clear the block.

A subscription can end up pointing at a Stripe PaymentMethod that no longer
exists or no longer belongs to its Stripe Customer, for example after a
cleanup script or a customer portal removal. When that happens, the next
attempt to change the card fails silently and the subscription is stuck.
This walks active subscriptions, checks each saved reference against Stripe,
and clears any reference that is confirmed dead. Read only until DRY_RUN is
turned off. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/cannot-change-the-card-twice/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_stale_card")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def active_subscriptions():
    """Yield active and on-hold subscriptions, paging through the REST API."""
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


def saved_payment_ref(sub):
    """(customer_id, payment_method_id) saved on the subscription, or (None, None)."""
    meta = {m.get("key"): m.get("value") for m in sub.get("meta_data") or []}
    customer_id = meta.get("_stripe_customer_id")
    pm_id = meta.get("_stripe_source_id") or meta.get("_payment_method_token")
    return customer_id, pm_id


def get_payment_method(pm_id):
    """Fetch the PaymentMethod from Stripe, or None if it does not exist."""
    if not pm_id:
        return None
    try:
        return stripe.PaymentMethod.retrieve(pm_id)
    except stripe.error.InvalidRequestError:
        return None


def decide(customer_id, pm_id, payment_method):
    """Pure decision: what should happen to this subscription's saved card.

    Returns a (action, reason) tuple. action is one of:
      skip  - nothing saved, there is nothing to repair
      clear - the saved reference is dead and blocking future changes
      ok    - the saved reference is still valid, leave it alone
    """
    if not pm_id or not customer_id:
        return ("skip", "no saved payment reference on this subscription")
    if payment_method is None:
        return ("clear", "saved PaymentMethod no longer exists in Stripe")
    if payment_method.get("customer") != customer_id:
        return ("clear", "saved PaymentMethod is no longer attached to this Stripe Customer")
    return ("ok", "saved PaymentMethod is still attached and valid")


def clear_stale_token(subscription_id, pm_id, reason):
    """Wipe the dead reference and leave a note explaining why."""
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"meta_data": [
            {"key": "_stripe_source_id", "value": ""},
            {"key": "_payment_method_token", "value": ""},
        ]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Cleared stale saved card {pm_id}: {reason}. "
                      f"The customer will need to add a new card on their next change "
                      f"payment method attempt."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    cleared = 0
    for sub in active_subscriptions():
        customer_id, pm_id = saved_payment_ref(sub)
        payment_method = get_payment_method(pm_id)
        action, reason = decide(customer_id, pm_id, payment_method)
        if action != "clear":
            continue
        log.info("Subscription %s: %s. %s", sub["id"], reason, "would clear" if DRY_RUN else "clearing")
        if not DRY_RUN:
            clear_stale_token(sub["id"], pm_id, reason)
        cleared += 1
    log.info("Done. %d subscription(s) %s.", cleared, "to clear" if DRY_RUN else "cleared")


if __name__ == "__main__":
    run()
