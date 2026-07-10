"""Restore a WooCommerce Subscription that is stuck on pending-cancel back to active.

A subscription in pending-cancel status carries a scheduled "end" date (the date it
will fully cancel at the end of the paid term). WooCommerce Subscriptions will not let
you set status back to active while that end date is still on the subscription,
because the status machine treats "has a pending cancellation date" as a reason to
block a direct jump to active. The fix is not to force the status field. It is to
clear the scheduled end date first, confirm the saved payment method still works with
Stripe, and only then move the subscription to active, the same order a support agent
would do it by hand in wp-admin. Read only unless DRY_RUN=false. Run once per
subscription id, or loop it over a list of ids from a report.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reactivate_pending_cancel")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Statuses WooCommerce Subscriptions itself considers "still paying".
REACTIVATABLE_FROM = {"pending-cancel", "on-hold"}
# Payment method statuses from Stripe that are safe to bill again.
USABLE_CARD_STATUSES = {"succeeded", "requires_capture"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in (order or {}).get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = (order or {}).get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(subscription, last_order, payment_method):
    """Pure decision function. No I/O. Returns (action, reason).

    subscription: dict with at least "status" and "schedule_end" (ISO string or "" )
    last_order: dict for the most recent renewal/parent order, or None
    payment_method: dict like {"status": "succeeded"} describing the saved Stripe
        payment method's last known usability, or None if there is nothing on file

    Actions:
      "skip"    - nothing to do, subscription is not in a blocked pending-cancel state
      "blocked" - it is pending-cancel but we cannot safely reactivate yet
      "repair"  - clear the scheduled end date and set the subscription back to active
    """
    if subscription is None:
        return ("skip", "subscription not found")
    status = subscription.get("status")
    if status not in REACTIVATABLE_FROM:
        return ("skip", "subscription is not in a reactivatable state")
    if status == "on-hold":
        return ("skip", "on-hold is a separate case, not covered here")

    intent_id = intent_id_of(last_order)
    if not intent_id:
        return ("blocked", "no saved PaymentIntent to confirm the card still works")

    if payment_method is None:
        return ("blocked", "could not read the saved payment method from Stripe")

    if payment_method.get("status") not in USABLE_CARD_STATUSES:
        return ("blocked", "saved payment method is not currently usable")

    schedule_end = subscription.get("schedule_end") or ""
    if not schedule_end:
        # Already clear, a plain status update would have worked, treat as a repair
        # of the status alone.
        return ("repair", "no leftover end date, just flip status to active")

    return ("repair", "leftover end date is blocking reactivation, clear it then activate")


def get_subscription(subscription_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        auth=AUTH, timeout=30,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_last_order(subscription):
    order_ids = subscription.get("_links", {}).get("orders")
    related = subscription.get("related_orders") or []
    order_id = related[-1] if related else subscription.get("last_order_id")
    if not order_id:
        return None
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_payment_method(intent_id):
    if not intent_id:
        return None
    try:
        intent = stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None
    return {"status": intent.get("status"), "payment_method": intent.get("payment_method")}


def reactivate(subscription_id):
    """Clear the scheduled end date, then move the subscription to active.

    Two writes on purpose. WooCommerce Subscriptions re-checks whether the status
    change is allowed on every PUT, so the end date has to be gone before the status
    field flips, otherwise the second write is rejected the same way the first one
    would have been.
    """
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"schedule_end": ""},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"status": "active"},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": "Reactivated by the pending-cancel repair script. Cleared the "
                      "scheduled end date and confirmed the saved payment method "
                      "before setting status back to active."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run(subscription_id):
    subscription = get_subscription(subscription_id)
    last_order = get_last_order(subscription) if subscription else None
    payment_method = get_payment_method(intent_id_of(last_order))
    action, reason = decide(subscription, last_order, payment_method)

    if action == "skip":
        log.info("Subscription %s: %s", subscription_id, reason)
        return
    if action == "blocked":
        log.warning("Subscription %s stayed pending-cancel: %s", subscription_id, reason)
        return

    log.info("Subscription %s: %s. %s", subscription_id, reason, "would reactivate" if DRY_RUN else "reactivating")
    if not DRY_RUN:
        reactivate(subscription_id)


if __name__ == "__main__":
    sub_id = os.environ.get("SUBSCRIPTION_ID")
    if not sub_id:
        raise SystemExit("Set SUBSCRIPTION_ID to the subscription post id to check")
    run(sub_id)
