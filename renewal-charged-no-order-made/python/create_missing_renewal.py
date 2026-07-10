"""Create the WooCommerce renewal order for a Stripe renewal charge that succeeded
with no order behind it.

WooCommerce Subscriptions is supposed to create a renewal order first and then
charge it through Stripe. If that scheduled action errors out partway, the charge
can still succeed on Stripe while no renewal order was ever written for it. This
walks recent succeeded renewal PaymentIntents, checks whether the subscription
already has a matching renewal order, and creates the missing order when it does
not. Dry run by default. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/renewal-charged-no-order-made/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("create_missing_renewal")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "48"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def recent_renewal_charges(lookback_hours):
    """Yield succeeded PaymentIntents from the lookback window that carry a
    subscription_id in their metadata, the way WooCommerce Subscriptions tags
    every renewal charge it initiates."""
    since = int(time.time()) - lookback_hours * 3600
    for intent in stripe.PaymentIntent.list(limit=100, created={"gte": since}).auto_paging_iter():
        if intent.status == "succeeded" and intent.metadata.get("subscription_id"):
            yield intent


def get_subscription(sub_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def has_order_for_intent(subscription, intent_id):
    """True if one of the subscription's existing renewal orders already
    matches this PaymentIntent."""
    for related_id in subscription.get("related_orders", {}).get("renewal", []):
        r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{related_id}", auth=AUTH, timeout=30)
        if r.status_code == 404:
            continue
        r.raise_for_status()
        if intent_id_of(r.json()) == intent_id:
            return True
    return False


def amount_minor_from_decimal(amount_str):
    """Convert a decimal string like '49.99' to minor units (cents) as an int.
    Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    need their own handling, since multiplying by 100 is wrong for those."""
    return round(float(amount_str) * 100)


def decide(subscription, intent, order_already_exists):
    """Pure decision function: no I/O, easy to unit test.

    Returns a (action, reason) tuple where action is one of:
      "skip"   - do nothing (intent not succeeded, or an order already covers it)
      "orphan" - the subscription this charge points to does not exist
      "create" - a real succeeded charge has no renewal order, make one
    """
    if intent.get("status") != "succeeded":
        return ("skip", "intent not succeeded")
    if subscription is None:
        return ("orphan", "subscription not found")
    if order_already_exists:
        return ("skip", "renewal order already exists for this charge")
    return ("create", "charged on Stripe, no renewal order on file")


def build_renewal_payload(subscription, intent):
    charge_id = intent.get("latest_charge") or intent["id"]
    return {
        "status": "processing",
        "customer_id": subscription["customer_id"],
        "payment_method": subscription.get("payment_method", "stripe"),
        "payment_method_title": subscription.get("payment_method_title", "Credit card (Stripe)"),
        "transaction_id": charge_id,
        "line_items": [
            {"product_id": item["product_id"], "quantity": item["quantity"]}
            for item in subscription.get("line_items", [])
        ],
        "meta_data": [
            {"key": "_stripe_intent_id", "value": intent["id"]},
            {"key": "_subscription_renewal", "value": str(subscription["id"])},
        ],
    }


def create_renewal_order(subscription, intent):
    payload = build_renewal_payload(subscription, intent)
    r = requests.post(f"{WOO_URL}/wp-json/wc/v3/orders", json=payload, auth=AUTH, timeout=30)
    r.raise_for_status()
    order = r.json()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Created after the fact from Stripe PaymentIntent {intent['id']}. "
                      f"The renewal charge succeeded on Stripe but the store never made an order for it."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    return order


def run():
    created = 0
    for intent in recent_renewal_charges(LOOKBACK_HOURS):
        sub_id = intent.metadata["subscription_id"]
        subscription = get_subscription(sub_id)
        already_exists = bool(subscription) and has_order_for_intent(subscription, intent["id"])
        action, reason = decide(subscription, intent, already_exists)
        if action == "orphan":
            log.warning("Intent %s points to subscription %s which is missing", intent.id, sub_id)
            continue
        if action == "skip":
            continue
        log.info("Subscription %s: %s. %s", sub_id, reason, "would create" if DRY_RUN else "creating")
        if not DRY_RUN:
            create_renewal_order(subscription, intent)
        created += 1
    log.info("Done. %d order(s) %s.", created, "to create" if DRY_RUN else "created")


if __name__ == "__main__":
    run()
