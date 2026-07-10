"""Stop WooCommerce Subscriptions from trying to auto bill through a gateway
you have disabled, such as WooPayments. Moves affected subscriptions to
manual renewal without changing price, next payment date, or line items.

Guide: https://www.allanninal.dev/woocommerce/billing-runs-after-woopayments-off/

Read only unless DRY_RUN is set to "false". Safe to run again and again,
since it skips any subscription already on manual renewal or already on a
gateway that is still enabled.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stop_billing_on_disabled_gateway")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DISABLED_GATEWAYS = [
    g.strip() for g in os.environ.get("DISABLED_GATEWAYS", "woocommerce_payments").split(",") if g.strip()
]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

BILLABLE_STATUSES = {"active", "on-hold"}


def is_manual(subscription):
    """True when the subscription is already set to require manual renewal."""
    value = subscription.get("requires_manual_renewal")
    return value in (True, "true", 1, "1")


def decide(subscription, disabled_gateways):
    """Pure decision: should this subscription be moved to manual renewal?

    No I/O. Takes plain dicts so it is trivial to unit test.
    """
    if subscription["status"] not in BILLABLE_STATUSES:
        return ("skip", "subscription is not billable")
    if is_manual(subscription):
        return ("skip", "already set to manual renewal")
    method = subscription.get("payment_method") or ""
    if method not in disabled_gateways:
        return ("skip", "payment method is not a disabled gateway")
    return ("repair", f"payment method '{method}' is disabled, would auto bill and fail")


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in (order or {}).get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = (order or {}).get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def get_intent(intent_id):
    if not intent_id or not stripe.api_key:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def billable_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active,on-hold", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            yield sub
        page += 1


def set_manual_renewal(subscription_id, method):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"requires_manual_renewal": True},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Moved to manual renewal. Payment method '{method}' is disabled, "
                      f"so automatic renewal would keep failing. Price and next payment "
                      f"date were not changed."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repaired = 0
    for subscription in billable_subscriptions():
        action, reason = decide(subscription, DISABLED_GATEWAYS)
        if action != "repair":
            continue
        last_order = subscription.get("last_order")
        intent = get_intent(intent_id_of(last_order)) if isinstance(last_order, dict) else None
        detail = f" Last attempt on Stripe: {intent['status']}." if intent else ""
        log.warning(
            "Subscription %s: %s.%s %s",
            subscription["id"], reason, detail,
            "would repair" if DRY_RUN else "repairing",
        )
        if not DRY_RUN:
            set_manual_renewal(subscription["id"], subscription.get("payment_method") or "")
        repaired += 1
    log.info("Done. %d subscription(s) %s.", repaired, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
