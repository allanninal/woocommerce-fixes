"""Find WooCommerce subscriptions still charging a legacy Stripe SEPA Source and
migrate them to a supported SEPA Debit PaymentMethod before the next renewal fails.

Stripe stopped accepting old `src_...` Sources for off-session SEPA renewals. An
order or subscription that still points at one of these will be rejected at the next
charge, usually with an error like "This payment method is not supported for this
API version" or the Source status shows "canceled" or "chargeable=false". This walks
recent renewal orders, reads the saved token from `_stripe_intent_id` / transaction_id
or order meta, and for any legacy Source, looks up the Stripe Customer for a newer
SEPA Debit PaymentMethod that can replace it. When one exists it re-links the order
and the subscription's saved token; otherwise it flags the order for the shopper to
re-enter their IBAN. Safe by default (DRY_RUN=true). Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("migrate_sepa_sources")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"), os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"))
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RENEWAL_STATUSES = {"pending", "on-hold", "failed"}
LEGACY_SOURCE_PREFIX = "src_"
SEPA_PM_TYPE = "sepa_debit"


def token_of(order):
    """The saved Stripe token for this order, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid or None


def is_legacy_source(token):
    return bool(token) and token.startswith(LEGACY_SOURCE_PREFIX)


def decide(order, token, replacement_pm):
    """Pure decision: what should we do about this order's saved payment token.

    order: dict with at least "status" and "id".
    token: the saved Stripe token string, or None.
    replacement_pm: a SEPA Debit PaymentMethod id (str) found on the customer, or None.

    Returns a tuple (action, reason) where action is one of:
      "skip"    - nothing to do, not a legacy Source problem
      "migrate" - a modern SEPA PaymentMethod exists, relink it
      "flag"    - legacy Source with no replacement, ask the shopper to re-enter their IBAN
    """
    if order["status"] not in RENEWAL_STATUSES:
        return ("skip", "order is not awaiting or retrying a renewal")
    if not is_legacy_source(token):
        return ("skip", "saved token is not a legacy Source")
    if replacement_pm:
        return ("migrate", "legacy Source found, a SEPA Debit PaymentMethod is available")
    return ("flag", "legacy Source found, no SEPA Debit PaymentMethod on file")


def find_sepa_payment_method(customer_id):
    """Return the id of the newest reusable SEPA Debit PaymentMethod for this customer, if any."""
    if not customer_id:
        return None
    methods = stripe.PaymentMethod.list(customer=customer_id, type=SEPA_PM_TYPE, limit=10)
    if not methods.data:
        return None
    newest = max(methods.data, key=lambda pm: pm.created)
    return newest.id


def renewal_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={
                "status": "pending,on-hold,failed",
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


def stripe_customer_id_of(order):
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_customer_id" and meta.get("value"):
            return meta["value"]
    return None


def migrate(order, replacement_pm):
    """Relink the order (and its parent subscription, if any) to the new PaymentMethod."""
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={
            "meta_data": [
                {"key": "_stripe_intent_id", "value": replacement_pm},
                {"key": "_stripe_source_id", "value": replacement_pm},
            ]
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={
            "note": (
                "Migrated from a legacy Stripe SEPA Source to PaymentMethod "
                f"{replacement_pm}. This order can now be retried or will use "
                "the new token on the next renewal."
            )
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def flag(order, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={
            "note": (
                f"SEPA payment check failed: {reason}. This order is on a legacy "
                "Stripe Source that Stripe no longer accepts for renewals, and no "
                "replacement SEPA Debit PaymentMethod was found. The shopper needs "
                "to re-enter their IBAN on the account page before the next renewal."
            )
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    migrated = 0
    flagged = 0
    for order in renewal_orders():
        token = token_of(order)
        customer_id = stripe_customer_id_of(order)
        replacement_pm = find_sepa_payment_method(customer_id) if is_legacy_source(token) else None
        action, reason = decide(order, token, replacement_pm)
        if action == "skip":
            continue
        log.info(
            "Order %s: %s. %s",
            order["id"], reason,
            "would " + action if DRY_RUN else action + "ing",
        )
        if action == "migrate":
            if not DRY_RUN:
                migrate(order, replacement_pm)
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
