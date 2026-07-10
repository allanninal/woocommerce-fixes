"""Backfill metadata.order_id on old Stripe PaymentIntents that predate it.

Older orders, orders created through a custom checkout, or PaymentIntents
recreated during a gateway migration can succeed without ever getting
order_id written into their Stripe metadata. The payment is fine, only the
label that lets later scripts match the PaymentIntent back to its
WooCommerce order is missing.

This script walks recent paid orders, reads the PaymentIntent id each order
already has saved (meta _stripe_intent_id, falling back to transaction_id),
fetches that PaymentIntent from Stripe, and writes order_id onto its
metadata when it is missing or wrong. It never touches the charge, the
amount, or the order status.

Guide: https://www.allanninal.dev/woocommerce/backfill-order-id-metadata/

Safe by default. Set DRY_RUN=false to actually write.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_order_id_metadata")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "365"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(order, intent):
    """Pure decision function. No I/O.

    order: a plain dict with at least id and status.
    intent: a plain dict with at least id, status, and metadata, or None
        when Stripe has no matching PaymentIntent.

    Returns (action, reason). action is one of:
      "skip"     - nothing to do, already correct or not worth touching
      "orphan"   - the saved intent id does not resolve in Stripe
      "backfill" - metadata.order_id is missing or wrong, write it
    """
    if intent is None:
        return ("orphan", "no matching PaymentIntent found in Stripe")
    existing = (intent.get("metadata") or {}).get("order_id")
    order_id_str = str(order["id"])
    if existing == order_id_str:
        return ("skip", "metadata.order_id already correct")
    if intent.get("status") not in ("succeeded", "processing"):
        return ("skip", "intent not in a paid state, leave it alone")
    return ("backfill", "metadata.order_id missing or pointing at the wrong order")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def paid_orders(lookback_days):
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=lookback_days)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "processing,completed", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def backfill_metadata(intent_id, order_id):
    stripe.PaymentIntent.modify(
        intent_id,
        metadata={"order_id": str(order_id)},
    )


def run():
    fixed = 0
    for order in paid_orders(LOOKBACK_DAYS):
        if order["status"] not in PAID_STATUSES:
            continue
        intent_id = intent_id_of(order)
        intent = get_intent(intent_id)
        action, reason = decide(order, intent)
        if action == "orphan":
            log.warning("Order %s: %s (intent id on order: %s)", order["id"], reason, intent_id)
            continue
        if action == "skip":
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would backfill" if DRY_RUN else "backfilling")
        if not DRY_RUN:
            backfill_metadata(intent["id"], order["id"])
        fixed += 1
    log.info("Done. %d PaymentIntent(s) %s.", fixed, "to backfill" if DRY_RUN else "backfilled")


if __name__ == "__main__":
    run()
