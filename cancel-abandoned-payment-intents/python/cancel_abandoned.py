"""Cancel abandoned Stripe PaymentIntents and their pending WooCommerce orders.
Never touches a real payment. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/cancel-abandoned-payment-intents/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cancel_abandoned")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "168"))
THRESHOLD_HOURS = int(os.environ.get("THRESHOLD_HOURS", "12"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ABANDONED = {"requires_payment_method", "requires_confirmation"}


def is_abandoned(intent, age_hours, threshold_hours):
    if intent.get("status") not in ABANDONED:
        return False
    if intent.get("last_payment_error"):
        return False
    return age_hours >= threshold_hours


def intents_with_age(lookback_hours):
    since = int(time.time()) - lookback_hours * 3600
    for intent in stripe.PaymentIntent.list(limit=100, created={"gte": since}).auto_paging_iter():
        if intent.metadata.get("order_id"):
            age_hours = (time.time() - intent["created"]) / 3600
            yield intent, age_hours


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def put_order(order_id, body):
    requests.put(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", json=body, auth=AUTH, timeout=30).raise_for_status()


def add_note(order_id, note):
    requests.post(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
                  json={"note": note}, auth=AUTH, timeout=30).raise_for_status()


def run():
    cancelled = 0
    for intent, age_hours in intents_with_age(LOOKBACK_HOURS):
        if not is_abandoned(intent, age_hours, THRESHOLD_HOURS):
            continue
        order_id = intent.metadata["order_id"]
        log.info("Intent %s (order %s) abandoned. %s", intent.id, order_id, "would cancel" if DRY_RUN else "cancelling")
        if not DRY_RUN:
            stripe.PaymentIntent.cancel(intent["id"], cancellation_reason="abandoned")
            order = get_order(order_id)
            if order and order["status"] == "pending":
                put_order(order_id, {"status": "cancelled"})
                add_note(order_id, f"Checkout was abandoned. Cancelled the Stripe PaymentIntent "
                                   f"{intent['id']} and the order to release stock.")
        cancelled += 1
    log.info("Done. %d abandoned intent(s) %s.", cancelled, "to cancel" if DRY_RUN else "cancelled")


if __name__ == "__main__":
    run()
