"""Restore WooCommerce orders that a late Stripe failure event reverted to failed.

Sometimes a charge.failed or payment_intent.payment_failed event for an earlier
attempt arrives AFTER the payment actually succeeded, and the gateway flips a good
order to failed or cancelled. Stripe is the source of truth: if it shows the
PaymentIntent as succeeded with a matching amount, the order should be paid.
This finds those reverted orders and moves them back to Processing.

Run on a schedule. Safe to run again and again.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restore_paid")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "72"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

REVERTED_STATUSES = {"failed", "cancelled"}


def recent_succeeded(lookback_hours):
    since = int(time.time()) - lookback_hours * 3600
    for intent in stripe.PaymentIntent.list(limit=100, created={"gte": since}).auto_paging_iter():
        if intent.status == "succeeded" and intent.metadata.get("order_id"):
            yield intent


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def order_amount_minor(order):
    return round(float(order["total"]) * 100)


def decide(order, intent):
    if intent.get("status") != "succeeded":
        return ("skip", "intent not succeeded")
    if order is None:
        return ("orphan", "order not found")
    if order["status"] not in REVERTED_STATUSES:
        return ("skip", "order not in a failed state")
    if abs(order_amount_minor(order) - intent["amount_received"]) > 1:
        return ("mismatch", "amount does not match")
    return ("restore", "paid in Stripe but order was reverted to failed")


def restore(order_id, intent):
    charge_id = intent.get("latest_charge") or intent["id"]
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"status": "processing", "transaction_id": charge_id},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Restored to processing. Stripe PaymentIntent {intent['id']} is "
                      f"succeeded, so a late failure event had reverted a paid order."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    restored = 0
    for intent in recent_succeeded(LOOKBACK_HOURS):
        order_id = intent.metadata["order_id"]
        order = get_order(order_id)
        action, reason = decide(order, intent)
        if action == "orphan":
            log.warning("Intent %s points to order %s which is missing", intent.id, order_id)
            continue
        if action in ("skip", "mismatch"):
            if action == "mismatch":
                log.warning("Order %s amount mismatch: %s", order_id, reason)
            continue
        log.info("Order %s: %s. %s", order_id, reason, "would restore" if DRY_RUN else "restoring")
        if not DRY_RUN:
            restore(order_id, intent)
        restored += 1
    log.info("Done. %d order(s) %s.", restored, "to restore" if DRY_RUN else "restored")


if __name__ == "__main__":
    run()
