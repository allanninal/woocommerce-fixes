"""Finish WooCommerce orders that Stripe already paid but the webhook missed.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/paid-orders-stuck-on-pending/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_pending")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


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
    if order["status"] in PAID_STATUSES:
        return ("skip", "order already paid")
    if abs(order_amount_minor(order) - intent["amount_received"]) > 1:
        return ("mismatch", "amount does not match")
    return ("fix", "paid in Stripe, still pending in Woo")


def mark_processing(order_id, intent):
    charge_id = intent.get("latest_charge") or intent["id"]
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"status": "processing", "transaction_id": charge_id},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Reconciled from Stripe PaymentIntent {intent['id']}. "
                      f"Payment was succeeded on Stripe. Marked processing by the reconciler."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
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
        log.info("Order %s: %s. %s", order_id, reason, "would fix" if DRY_RUN else "fixing")
        if not DRY_RUN:
            mark_processing(order_id, intent)
        fixed += 1
    log.info("Done. %d order(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
