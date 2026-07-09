"""Recover the Stripe PaymentIntent ID for WooCommerce orders that lost it,
so the order can be matched, completed, and refunded again.

Guide: https://www.allanninal.dev/woocommerce/missing-intent-id-webhook-cannot-match-order/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_intent_id")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def get_meta(order, key):
    for m in order.get("meta_data", []):
        if m.get("key") == key:
            return m.get("value")
    return None


def needs_backfill(order):
    if not order["payment_method"].startswith("stripe"):
        return False
    if order["status"] in PAID_STATUSES:
        return False
    return not get_meta(order, "_stripe_intent_id")


def unpaid_stripe_orders():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "pending,on-hold", "payment_method": "stripe",
                    "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        orders = r.json()
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def find_intent(order_id):
    query = f"metadata['order_id']:'{order_id}' AND status:'succeeded'"
    result = stripe.PaymentIntent.search(query=query, limit=1)
    return result.data[0] if result.data else None


def backfill(order_id, intent):
    charge_id = intent.get("latest_charge") or intent["id"]
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={
            "status": "processing",
            "transaction_id": charge_id,
            "meta_data": [
                {"key": "_stripe_intent_id", "value": intent["id"]},
                {"key": "_stripe_charge_id", "value": charge_id},
            ],
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Recovered Stripe PaymentIntent {intent['id']} and backfilled the order. "
                      f"Marked processing by the repair script."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for order in unpaid_stripe_orders():
        if not needs_backfill(order):
            continue
        order_id = order["id"]
        intent = find_intent(order_id)
        if intent is None:
            log.warning("Order %s has no successful payment on Stripe. Left alone.", order_id)
            continue
        log.info("Order %s: recovered %s. %s", order_id, intent.id, "would fix" if DRY_RUN else "fixing")
        if not DRY_RUN:
            backfill(order_id, intent)
        fixed += 1
    log.info("Done. %d order(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
