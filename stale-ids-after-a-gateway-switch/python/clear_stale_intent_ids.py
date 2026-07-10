"""Clear stale Stripe PaymentIntent IDs left behind after a gateway switch.

When a store moves to a new Stripe account, a new Stripe mode (test to live),
or a different payment gateway entirely, old orders keep the previous
PaymentIntent id in meta `_stripe_intent_id` (or `transaction_id`). That id
does not exist under the new secret key. Any later action that reads it,
a refund, a renewal charge, a sync job, fails with a Stripe "No such
payment_intent" error, even though the order itself is fine.

This walks recent orders, tries to resolve the saved id against the current
Stripe account, and clears the stale meta (and adds a note) on orders whose
id cannot be resolved and whose payment already finished. It never touches
an order whose id resolves fine, and it never touches an order that is
still waiting on payment. Read only by default. Run once after a gateway
switch, or on a schedule while you clean up the backlog.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_stale_intent_ids")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FINISHED_STATUSES = {"processing", "completed", "refunded", "on-hold"}
UNRESOLVED_ERROR_CODES = {"resource_missing"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(order, lookup_result):
    """Pure decision. lookup_result is one of:
    "resolved"   the id was found in the current Stripe account
    "not_found"  Stripe returned resource_missing for the id
    "no_id"      the order has no saved PaymentIntent id at all
    """
    if order["status"] not in FINISHED_STATUSES:
        return ("skip", "order is not yet finished, leave the id alone")
    if lookup_result == "no_id":
        return ("skip", "no PaymentIntent id saved on this order")
    if lookup_result == "resolved":
        return ("skip", "id resolves fine in the current Stripe account")
    if lookup_result == "not_found":
        return ("clear", "id does not exist in the current Stripe account, stale from a gateway switch")
    return ("skip", "unknown lookup result")


def lookup_intent(intent_id):
    """Ask Stripe about an id. Returns "no_id", "resolved", or "not_found"."""
    if not intent_id:
        return "no_id"
    try:
        stripe.PaymentIntent.retrieve(intent_id)
        return "resolved"
    except stripe.error.InvalidRequestError as exc:
        code = getattr(exc, "code", None)
        if code in UNRESOLVED_ERROR_CODES or getattr(exc, "http_status", None) == 404:
            return "not_found"
        raise


def recent_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def clear_stale_id(order, old_intent_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={
            "transaction_id": "",
            "meta_data": [{"key": "_stripe_intent_id", "value": ""}],
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Cleared a stale Stripe PaymentIntent id ({old_intent_id}) left over from a "
                      f"gateway switch. This id does not exist in the current Stripe account, so it "
                      f"was removed to stop future actions on this order from failing."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    cleared = 0
    for order in recent_orders():
        old_intent_id = intent_id_of(order)
        lookup_result = lookup_intent(old_intent_id)
        action, reason = decide(order, lookup_result)
        if action != "clear":
            continue
        log.warning("Order %s: %s. %s", order["id"], reason, "would clear" if DRY_RUN else "clearing")
        if not DRY_RUN:
            clear_stale_id(order, old_intent_id)
        cleared += 1
    log.info("Done. %d order(s) %s.", cleared, "to clear" if DRY_RUN else "cleared")


if __name__ == "__main__":
    run()
