"""Resolve WooCommerce orders stuck on 3D Secure with Stripe.
Complete the ones that paid, fail the old ones that never finished.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/orders-stuck-requires-action-3ds/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resolve_3ds")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "48"))
THRESHOLD_HOURS = int(os.environ.get("THRESHOLD_HOURS", "6"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}
WAITING = {"requires_action", "requires_payment_method", "requires_confirmation", "processing"}


def classify(status, age_hours, threshold_hours):
    if status == "succeeded":
        return "complete"
    if status in WAITING:
        return "fail" if age_hours >= threshold_hours else "wait"
    return "wait"


def candidate_intents(lookback_hours):
    since = int(time.time()) - lookback_hours * 3600
    for intent in stripe.PaymentIntent.list(limit=100, created={"gte": since}).auto_paging_iter():
        if intent.metadata.get("order_id") and intent.status != "canceled":
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
    completed = failed = 0
    for intent, age_hours in candidate_intents(LOOKBACK_HOURS):
        order_id = intent.metadata["order_id"]
        action = classify(intent.status, age_hours, THRESHOLD_HOURS)
        if action == "wait":
            continue
        order = get_order(order_id)
        if not order or order["status"] in PAID_STATUSES:
            continue
        if action == "complete":
            log.info("Order %s: 3DS paid later. %s", order_id, "would complete" if DRY_RUN else "completing")
            if not DRY_RUN:
                charge_id = intent.get("latest_charge") or intent["id"]
                put_order(order_id, {"status": "processing", "transaction_id": charge_id})
                add_note(order_id, f"3D Secure payment {intent['id']} completed later. Marked processing.")
            completed += 1
        elif action == "fail":
            log.info("Order %s: 3DS never finished. %s", order_id, "would fail" if DRY_RUN else "failing")
            if not DRY_RUN:
                put_order(order_id, {"status": "failed"})
                add_note(order_id, f"3D Secure was never completed for {intent['id']}. Marked failed to release stock.")
            failed += 1
    log.info("Done. %d completed, %d failed %s.", completed, failed, "(dry run)" if DRY_RUN else "")


if __name__ == "__main__":
    run()
