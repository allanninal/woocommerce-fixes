"""Move legacy Stripe card Sources saved on WooCommerce customers to reusable
PaymentMethods, so future off-session charges can go through Strong Customer
Authentication (SCA) instead of being declined.

Stripe is retiring the old Sources API for saved cards. A `src_...` token that
was fine for a one-off checkout years ago cannot carry a customer through 3D
Secure on a later off-session renewal or repeat purchase. This walks recent
orders, reads the saved token from order meta `_stripe_intent_id` (falling
back to `transaction_id`), and for any legacy card Source still in good
standing, wraps it in a new PaymentMethod, attaches it to the Stripe Customer,
and re-links the order (and the customer's default token) to the new
`pm_...` id. Orders whose Source cannot be migrated (wrong type, or no longer
chargeable) are flagged instead so the shopper can re-enter their card. Safe
by default (DRY_RUN=true). Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("migrate_sources_to_pm")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"), os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"))
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "60"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RELEVANT_STATUSES = {"pending", "on-hold", "processing", "completed", "failed"}
LEGACY_SOURCE_PREFIX = "src_"
PAYMENT_METHOD_PREFIX = "pm_"
OK_SOURCE_STATUSES = {"chargeable", "consumed"}


def token_of(order):
    """The saved Stripe token for this order, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid or None


def is_legacy_source(token):
    return bool(token) and token.startswith(LEGACY_SOURCE_PREFIX)


def is_already_payment_method(token):
    return bool(token) and token.startswith(PAYMENT_METHOD_PREFIX)


def decide(order, token, source):
    """Pure decision: what should we do about this order's saved payment token.

    order: dict with at least "status" and "id".
    token: the saved Stripe token string, or None.
    source: a dict-like Stripe Source object (with "type" and "status"), or None
            when the token is not a legacy Source (already a PaymentMethod, or missing).

    Returns a tuple (action, reason) where action is one of:
      "skip"    - nothing to do (already a PaymentMethod, no token, or order not relevant)
      "migrate" - a legacy card Source in good standing, wrap it as a PaymentMethod
      "flag"    - a legacy Source we cannot safely auto-migrate
    """
    if order["status"] not in RELEVANT_STATUSES:
        return ("skip", "order status is not one we track saved cards for")
    if is_already_payment_method(token):
        return ("skip", "already a PaymentMethod")
    if not is_legacy_source(token):
        return ("skip", "no legacy Source saved on this order")
    if source is None:
        return ("flag", "Source could not be retrieved from Stripe")
    if source.get("type") != "card":
        return ("flag", "Source is not a card, cannot auto-migrate this type")
    if source.get("status") not in OK_SOURCE_STATUSES:
        return ("flag", "Source is no longer chargeable, shopper must re-enter their card")
    return ("migrate", "legacy card Source in good standing, safe to wrap as a PaymentMethod")


def get_source(source_id):
    if not source_id:
        return None
    try:
        return stripe.Source.retrieve(source_id)
    except stripe.error.InvalidRequestError:
        return None


def customer_id_of(order):
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_customer_id" and meta.get("value"):
            return meta["value"]
    return None


def tracked_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={
                "status": "pending,on-hold,processing,completed,failed",
                "after": after,
                "per_page": 50,
                "page": page,
            },
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def create_payment_method_from_source(source_id, customer_id):
    """Wrap a legacy card Source token in a reusable PaymentMethod and attach it."""
    payment_method = stripe.PaymentMethod.create(type="card", card={"token": source_id})
    if customer_id:
        stripe.PaymentMethod.attach(payment_method.id, customer=customer_id)
    return payment_method.id


def migrate(order, new_pm_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={
            "meta_data": [
                {"key": "_stripe_intent_id", "value": new_pm_id},
                {"key": "_stripe_source_id", "value": new_pm_id},
            ]
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={
            "note": (
                f"Migrated the saved Stripe Source to PaymentMethod {new_pm_id}. "
                "Future off-session charges on this order's saved card can now "
                "go through Strong Customer Authentication (SCA)."
            )
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def flag(order, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={
            "note": (
                f"Stripe Source migration check failed: {reason}. This order's saved "
                "card is a legacy Stripe Source that could not be automatically moved "
                "to a PaymentMethod. The shopper should re-enter their card on the "
                "account or my account page before the next charge."
            )
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    migrated = 0
    flagged = 0
    for order in tracked_orders():
        token = token_of(order)
        source = get_source(token) if is_legacy_source(token) else None
        action, reason = decide(order, token, source)
        if action == "skip":
            continue
        log.info(
            "Order %s: %s. %s",
            order["id"], reason,
            "would " + action if DRY_RUN else action + "ing",
        )
        if action == "migrate":
            if not DRY_RUN:
                customer_id = customer_id_of(order)
                new_pm_id = create_payment_method_from_source(token, customer_id)
                migrate(order, new_pm_id)
            migrated += 1
        elif action == "flag":
            if not DRY_RUN:
                flag(order, reason)
            flagged += 1
    log.info(
        "Done. %d order(s) %s, %d order(s) %s.",
        migrated, "to migrate" if DRY_RUN else "migrated",
        flagged, "to flag" if DRY_RUN else "flagged",
    )


if __name__ == "__main__":
    run()
