"""Match SOFORT, Klarna, and other delayed methods that succeeded after checkout
to the WooCommerce order they belong to. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/slow-methods-succeed-but-never-match/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("match_delayed_payments")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "72"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Payment method types that confirm asynchronously, sometimes hours after checkout.
DELAYED_METHODS = {"sofort", "klarna", "sepa_debit", "bancontact", "ideal"}
PAID_STATUSES = {"processing", "completed"}
CLOSED_STATUSES = {"cancelled", "refunded", "failed", "trash"}


def recent_succeeded_delayed(lookback_hours):
    """Yield Stripe PaymentIntents that are succeeded and used a delayed method."""
    since = int(time.time()) - lookback_hours * 3600
    for intent in stripe.PaymentIntent.list(limit=100, created={"gte": since}).auto_paging_iter():
        if intent.status != "succeeded":
            continue
        methods = set(intent.get("payment_method_types") or [])
        if methods & DELAYED_METHODS:
            yield intent


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def find_order_by_intent(intent_id):
    """Fallback lookup for when the PaymentIntent has no order_id in metadata."""
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"search": intent_id, "per_page": 5},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    matches = r.json()
    return matches[0] if matches else None


def resolve_order(intent):
    order_id = intent.metadata.get("order_id")
    order = get_order(order_id) if order_id else None
    if order is not None:
        return order
    return find_order_by_intent(intent["id"])


def order_amount_minor(order):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # need their own rounding rule, since 50.00 is wrong for those.
    return round(float(order["total"]) * 100)


def decide(order, intent):
    """Pure decision function: no I/O, easy to unit test.

    Returns a (action, reason) tuple where action is one of:
    "fix", "skip", "mismatch", "orphan".
    """
    if intent.get("status") != "succeeded":
        return ("skip", "intent not succeeded")
    if order is None:
        return ("orphan", "order not found")
    if order["status"] in PAID_STATUSES:
        return ("skip", "order already paid")
    if order["status"] in CLOSED_STATUSES:
        return ("skip", "order already closed")
    if order.get("currency", "").lower() != intent.get("currency", "").lower():
        return ("mismatch", "currency does not match")
    if abs(order_amount_minor(order) - intent["amount_received"]) > 1:
        return ("mismatch", "amount does not match")
    return ("fix", "delayed method succeeded, order never caught up")


def mark_processing(order_id, intent):
    charge_id = intent.get("latest_charge") or intent["id"]
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={
            "status": "processing",
            "transaction_id": charge_id,
            "meta_data": [{"key": "_stripe_intent_id", "value": intent["id"]}],
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Matched to Stripe PaymentIntent {intent['id']} ({intent.get('payment_method_types')}), "
                      f"which confirmed after checkout. Marked processing by the reconciler."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for intent in recent_succeeded_delayed(LOOKBACK_HOURS):
        order = resolve_order(intent)
        order_id = order["id"] if order else intent.metadata.get("order_id")
        action, reason = decide(order, intent)
        if action == "orphan":
            log.warning("Intent %s has no matching order", intent.id)
            continue
        if action in ("skip", "mismatch"):
            if action == "mismatch":
                log.warning("Order %s: %s", order_id, reason)
            continue
        log.info("Order %s: %s. %s", order_id, reason, "would fix" if DRY_RUN else "fixing")
        if not DRY_RUN:
            mark_processing(order_id, intent)
        fixed += 1
    log.info("Done. %d order(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
