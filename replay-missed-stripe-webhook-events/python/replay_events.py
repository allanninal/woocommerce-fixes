"""Replay Stripe webhook events WooCommerce missed during downtime.
Idempotent. Run once after an outage, or on a schedule as a safety net.

Guide: https://www.allanninal.dev/woocommerce/replay-missed-stripe-webhook-events/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("replay_events")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "120"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def extract_action(event):
    obj = event.get("data", {}).get("object", {})
    order_id = (obj.get("metadata") or {}).get("order_id")
    if not order_id:
        return None
    if event["type"] == "payment_intent.succeeded":
        return ("complete", order_id, obj)
    if event["type"] == "charge.refunded":
        return ("refund", order_id, obj)
    return None


def undelivered_events(lookback_hours):
    since = int(time.time()) - lookback_hours * 3600
    return stripe.Event.list(
        limit=100, created={"gte": since}, delivery_success=False,
        types=["payment_intent.succeeded", "charge.refunded"],
    ).auto_paging_iter()


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


def sync_refund(order, charge):
    order_total_minor = round(float(order["total"]) * 100)
    stripe_refunded = charge.get("amount_refunded", 0)
    wc_refunded = sum(round(abs(float(r["total"])) * 100) for r in order.get("refunds", []))
    missing = stripe_refunded - wc_refunded
    if missing > 1:
        requests.post(f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/refunds",
                      json={"amount": f"{missing / 100:.2f}", "api_refund": False,
                            "reason": "Replayed a missed Stripe refund event."},
                      auth=AUTH, timeout=30).raise_for_status()
        if stripe_refunded >= order_total_minor and order["status"] != "refunded":
            put_order(order["id"], {"status": "refunded"})


def apply_event(action, order_id, obj):
    order = get_order(order_id)
    if not order:
        return False
    if action == "complete" and order["status"] not in PAID_STATUSES:
        charge_id = obj.get("latest_charge") or obj["id"]
        put_order(order_id, {"status": "processing", "transaction_id": charge_id})
        add_note(order_id, "Replayed a missed Stripe payment event. Marked processing.")
        return True
    if action == "refund":
        sync_refund(order, obj)
        return True
    return False


def run():
    seen = set()
    applied = 0
    for event in undelivered_events(LOOKBACK_HOURS):
        if event["id"] in seen:
            continue
        seen.add(event["id"])
        parsed = extract_action(event)
        if not parsed:
            continue
        action, order_id, obj = parsed
        log.info("Event %s -> %s order %s. %s", event["id"], action, order_id, "dry run" if DRY_RUN else "applying")
        if not DRY_RUN and apply_event(action, order_id, obj):
            applied += 1
    log.info("Done. %d event(s) %s.", applied, "found" if DRY_RUN else "reapplied")


if __name__ == "__main__":
    run()
