"""Capture WooCommerce orders whose Stripe authorization was never captured.

Manual-capture orders sit on hold with an authorized-but-uncaptured PaymentIntent.
Stripe holds an authorization for about 7 days, then releases it and the money is
gone. This finds authorized PaymentIntents whose order is still on hold, checks the
amount, and captures them before the hold expires.

Run on a schedule. Safe to run again and again.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("capture_authorized")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "168"))  # 7 days
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CAPTURABLE_STATUSES = {"on-hold", "pending"}


def recent_uncaptured(lookback_hours):
    since = int(time.time()) - lookback_hours * 3600
    for intent in stripe.PaymentIntent.list(limit=100, created={"gte": since}).auto_paging_iter():
        if intent.status == "requires_capture" and intent.metadata.get("order_id"):
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
    # An authorized PaymentIntent reports the held amount in `amount`, not
    # `amount_received`, because nothing has been captured yet.
    if intent.get("status") != "requires_capture":
        return ("skip", "not awaiting capture")
    if order is None:
        return ("orphan", "order not found")
    if order["status"] not in CAPTURABLE_STATUSES:
        return ("skip", "order not awaiting capture")
    if abs(order_amount_minor(order) - intent["amount"]) > 1:
        return ("mismatch", "amount does not match")
    return ("capture", "authorized in Stripe, still awaiting capture")


def capture(order_id, intent):
    charge = stripe.PaymentIntent.capture(intent["id"])
    charge_id = charge.get("latest_charge") or intent["id"]
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"status": "processing", "transaction_id": charge_id},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Captured Stripe PaymentIntent {intent['id']} before the "
                      f"authorization expired. Marked processing by the capture job."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    captured = 0
    for intent in recent_uncaptured(LOOKBACK_HOURS):
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
        log.info("Order %s: %s. %s", order_id, reason, "would capture" if DRY_RUN else "capturing")
        if not DRY_RUN:
            capture(order_id, intent)
        captured += 1
    log.info("Done. %d order(s) %s.", captured, "to capture" if DRY_RUN else "captured")


if __name__ == "__main__":
    run()
