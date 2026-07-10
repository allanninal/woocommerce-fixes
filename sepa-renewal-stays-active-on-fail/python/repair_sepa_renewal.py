"""Move SEPA renewal orders to on-hold when the mandate failed after the fact.

SEPA Direct Debit reports a PaymentIntent as processing right away, so WooCommerce
marks the renewal paid before the bank has actually confirmed the debit. If the
bank later returns it unpaid and that webhook is missed, the renewal order and the
subscription stay active with no real payment behind them. This walks recent paid
renewal orders, rereads the PaymentIntent status straight from Stripe, and moves any
order whose SEPA mandate truly failed to on-hold so dunning can run. Safe to run
again and again. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/sepa-renewal-stays-active-on-fail/
"""
import os
import datetime
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_sepa_renewal")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}
FAILED_INTENT_STATUSES = {"requires_payment_method", "canceled"}
ALREADY_HANDLED_STATUSES = {"on-hold", "failed"}


def paid_renewal_orders(lookback_days):
    """Yield WooCommerce Subscriptions renewal orders that are currently marked paid."""
    after = (datetime.date.today() - datetime.timedelta(days=lookback_days)).isoformat() + "T00:00:00"
    page = 1
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
            if any(m.get("key") == "_subscription_renewal" for m in order.get("meta_data") or []):
                yield order
        page += 1


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def decide(order, intent):
    """Pure decision function. No I/O. Returns (action, reason).

    action is one of:
      "skip"    - nothing to do (already handled, not paid, no intent, or truly succeeded)
      "wait"    - SEPA is still settling, not a confirmed failure yet
      "repair"  - Stripe now shows a real failure on an order still marked paid
    """
    if order["status"] in ALREADY_HANDLED_STATUSES:
        return ("skip", "already moved off active")
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order not in a paid state")
    if intent is None:
        return ("skip", "no PaymentIntent to check")
    if intent.get("status") == "succeeded":
        return ("skip", "Stripe confirms the payment succeeded")
    if intent.get("status") not in FAILED_INTENT_STATUSES:
        return ("wait", "SEPA still processing, not a failure yet")
    return ("repair", "SEPA mandate failed after the renewal was marked paid")


def mark_on_hold(order_id, intent):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"status": "on-hold"},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"SEPA mandate failed after this renewal was marked paid. "
                      f"Stripe PaymentIntent {intent['id']} now shows {intent['status']}. "
                      f"Moved to on-hold so payment retries can run."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repaired = 0
    for order in paid_renewal_orders(LOOKBACK_DAYS):
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent)
        if action != "repair":
            if action == "wait":
                log.info("Order %s: %s", order["id"], reason)
            continue
        log.warning("Order %s: %s. %s", order["id"], reason, "would repair" if DRY_RUN else "repairing")
        if not DRY_RUN:
            mark_on_hold(order["id"], intent)
        repaired += 1
    log.info("Done. %d order(s) %s.", repaired, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
