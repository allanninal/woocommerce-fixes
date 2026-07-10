"""Fix subscriptions dunned for a zero amount Stripe card check, not a real failed renewal.

Stripe sometimes verifies a saved card with a $0 PaymentIntent, for example after a card
updater event or a trial signup. If that check does not come back clean, some failure
handling treats it exactly like a declined renewal charge. This walks recently dunned
subscriptions, reads the PaymentIntent behind the last order, and reactivates any
subscription whose "failure" was really a zero amount check. Read only by default is not
possible here (the point is to restore access), so it defaults to a dry run instead.

Guide: https://www.allanninal.dev/woocommerce/card-check-read-as-a-failed-payment/
"""
import os
import datetime
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("card_check_auditor")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "3"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FAILED_STATUSES = {"on-hold", "pending-cancel"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(subscription, intent):
    """Pure decision: should a dunned subscription be restored because the
    "failed" intent behind it was really a zero amount card check?

    subscription: dict with at least a "status" key.
    intent: a Stripe PaymentIntent-like dict (or None if there was nothing to check),
        read for "amount" (minor units) and "status".
    Returns a (action, reason) tuple. action is one of "restore" or "skip".
    """
    if subscription["status"] not in FAILED_STATUSES:
        return ("skip", "subscription is not in a dunned state")
    if intent is None:
        return ("skip", "no Stripe intent to check")
    if intent.get("amount", 0) == 0:
        return ("restore", "the failed intent was a zero amount card check")
    if intent.get("status") == "succeeded":
        return ("skip", "the intent actually succeeded, nothing to fix")
    return ("skip", "a real charge was attempted and declined")


def get_order(order_id):
    if not order_id:
        return None
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def held_subscriptions():
    after = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat() + "T00:00:00"
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "on-hold,pending-cancel", "modified_after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        yield from batch
        page += 1


def restore(subscription_id, intent):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"status": "active"}, auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Reactivated by the card check auditor. PaymentIntent {intent['id']} "
                      f"had amount 0, a card check, not a failed renewal. No dunning is owed here."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    restored = 0
    for subscription in held_subscriptions():
        last_order_id = subscription.get("last_order_id") or subscription.get("last_order")
        order = get_order(last_order_id)
        intent = get_intent(intent_id_of(order)) if order else None
        action, reason = decide(subscription, intent)
        if action != "restore":
            continue
        log.info("Subscription %s: %s. %s", subscription["id"], reason, "would restore" if DRY_RUN else "restoring")
        if not DRY_RUN:
            restore(subscription["id"], intent)
        restored += 1
    log.info("Done. %d subscription(s) %s.", restored, "to restore" if DRY_RUN else "restored")


if __name__ == "__main__":
    run()
