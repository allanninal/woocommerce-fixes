"""Move WooCommerce orders left on Pending by a declined Stripe card to Failed.
Frees the held stock. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/declined-card-order-stuck-pending/
"""
import os
import logging
from datetime import datetime, timezone, timedelta
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fail_declined")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
MIN_AGE_HOURS = int(os.environ.get("MIN_AGE_HOURS", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def is_declined(intent):
    if intent.get("status") != "requires_payment_method":
        return False
    return bool(intent.get("last_payment_error"))


def get_meta(order, key):
    for m in order.get("meta_data", []):
        if m.get("key") == key:
            return m.get("value")
    return None


def pending_stripe_orders(before_iso):
    page = 1
    while True:
        r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders",
                         params={"status": "pending", "payment_method": "stripe",
                                 "before": before_iso, "per_page": 50, "page": page},
                         auth=AUTH, timeout=30)
        r.raise_for_status()
        orders = r.json()
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def put_order(order_id, body):
    requests.put(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", json=body, auth=AUTH, timeout=30).raise_for_status()


def add_note(order_id, note):
    requests.post(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
                  json={"note": note}, auth=AUTH, timeout=30).raise_for_status()


def run():
    before = (datetime.now(timezone.utc) - timedelta(hours=MIN_AGE_HOURS)).isoformat()
    failed = 0
    for order in pending_stripe_orders(before):
        intent_id = get_meta(order, "_stripe_intent_id")
        if not intent_id:
            continue
        intent = stripe.PaymentIntent.retrieve(intent_id)
        if not is_declined(intent):
            continue
        error = intent.get("last_payment_error") or {}
        reason = error.get("message") or error.get("code") or "card declined"
        log.info("Order %s: declined (%s). %s", order["id"], reason, "would fail" if DRY_RUN else "failing")
        if not DRY_RUN:
            put_order(order["id"], {"status": "failed"})
            add_note(order["id"], f"Stripe declined the payment: {reason}. Marked failed to release stock.")
        failed += 1
    log.info("Done. %d order(s) %s.", failed, "to fail" if DRY_RUN else "failed")


if __name__ == "__main__":
    run()
