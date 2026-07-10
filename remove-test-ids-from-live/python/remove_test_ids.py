"""Find and clear test mode Stripe PaymentIntent ids saved on live WooCommerce orders.

A test id and a live id look identical, both start with pi_, so the only reliable
check is asking the live Stripe account to retrieve it. Run once after a migration,
then on a light schedule for a few weeks. Read only by default.

Guide: https://www.allanninal.dev/woocommerce/remove-test-ids-from-live/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("remove_test_ids")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
REVIEW_HOLD = os.environ.get("REVIEW_HOLD", "false").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed", "on-hold"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def get_intent(intent_id):
    """Retrieve a PaymentIntent from the live Stripe account, or None if it does not exist there."""
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError as e:
        if getattr(e, "code", None) == "resource_missing":
            return None
        raise


def decide(order, intent_id, intent):
    """Pure decision function: no I/O, easy to unit test.

    order: a dict with at least "status".
    intent_id: the id read off the order (or None).
    intent: the object returned by a live-mode lookup for that id (or None if missing).
    """
    if not intent_id:
        return ("skip", "no Stripe id saved on this order")
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order is not in a state that relies on this id")
    if intent is not None:
        return ("ok", "id resolves on the live Stripe account")
    return ("clear", "id does not exist on the live Stripe account, likely test mode")


def candidate_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "processing,completed,on-hold", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def clear_test_id(order_id, intent_id):
    # Money math note: this script does not compare amounts, it only clears a
    # reference that the live Stripe account cannot resolve. Any amount checks
    # that need it should keep totals in minor units (cents), not floats.
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"transaction_id": "", "meta_data": [{"key": "_stripe_intent_id", "value": ""}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Cleared Stripe id {intent_id}: it does not exist on the live "
                      f"Stripe account and is likely a test mode id. Please confirm this "
                      f"order was actually paid before shipping or renewing it."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    if REVIEW_HOLD:
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
            json={"status": "on-hold"}, auth=AUTH, timeout=30,
        ).raise_for_status()


def run():
    cleared = 0
    for order in candidate_orders():
        intent_id = intent_id_of(order)
        intent = get_intent(intent_id)
        action, reason = decide(order, intent_id, intent)
        if action != "clear":
            continue
        log.warning("Order %s: %s. %s", order["id"], reason, "would clear" if DRY_RUN else "clearing")
        if not DRY_RUN:
            clear_test_id(order["id"], intent_id)
        cleared += 1
    log.info("Done. %d order(s) %s.", cleared, "to clear" if DRY_RUN else "cleared")


if __name__ == "__main__":
    run()
