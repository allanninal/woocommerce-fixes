"""Repair WooCommerce orders dropped by a Stripe API version mismatch.

Older Stripe API versions (before 2022-11-15) returned a `charges` list on
every PaymentIntent, so `intent["charges"]["data"][0]["id"]` worked. On newer
API versions that list is gone by default; the charge lives on
`intent["latest_charge"]` instead. A webhook handler or script still written
for the old shape reads an empty `charges` list, decides there is no charge
yet, and skips the order, so it never gets a transaction id and can be left
on Pending even though Stripe already has a succeeded charge.

This walks orders that have a saved PaymentIntent id but no transaction id,
reads the intent from Stripe, resolves the charge id from whichever field is
present, and writes it onto the order along with a note. Safe to run again
and again. Read only until DRY_RUN is turned off.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resolve_charge_id")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def charge_id_of(intent):
    """Resolve a charge id from a PaymentIntent regardless of API version.

    Newer API versions (2022-11-15 and later) put the charge on
    `latest_charge`. Older versions only have the `charges` list. Try the
    new field first since it is a plain string on every supported version
    once it exists, then fall back to the legacy nested list.
    """
    latest = intent.get("latest_charge")
    if isinstance(latest, str) and latest:
        return latest
    if isinstance(latest, dict) and latest.get("id"):
        return latest["id"]
    charges = intent.get("charges") or {}
    data = charges.get("data") or []
    if data and data[0].get("id"):
        return data[0]["id"]
    return None


def order_amount_minor(order):
    return round(float(order["total"]) * 100)


def decide(order, intent):
    """Pure decision. No I/O. Returns (action, reason)."""
    if intent_id_of(order) is None:
        return ("skip", "no saved PaymentIntent id on this order")
    if order.get("transaction_id"):
        return ("skip", "order already has a transaction id")
    if intent is None:
        return ("skip", "PaymentIntent not found on Stripe")
    if intent.get("status") != "succeeded":
        return ("skip", "PaymentIntent is not succeeded yet")
    charge_id = charge_id_of(intent)
    if charge_id is None:
        return ("orphan", "succeeded but no charge id on either API shape")
    if abs(order_amount_minor(order) - intent.get("amount_received", 0)) > 1:
        return ("mismatch", "amount does not match the PaymentIntent")
    return ("repair", "succeeded in Stripe, charge id was never saved")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def candidate_orders():
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


def apply_charge_id(order_id, charge_id, intent_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"status": "processing", "transaction_id": charge_id},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Recovered charge {charge_id} from PaymentIntent {intent_id}. "
                      f"The webhook handler could not read the newer API response shape, "
                      f"this was backfilled by the reconciler."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repaired = 0
    for order in candidate_orders():
        intent_id = intent_id_of(order)
        if intent_id is None:
            continue
        intent = get_intent(intent_id)
        action, reason = decide(order, intent)
        if action == "orphan":
            log.warning("Order %s: %s", order["id"], reason)
            continue
        if action in ("skip", "mismatch"):
            if action == "mismatch":
                log.warning("Order %s amount mismatch: %s", order["id"], reason)
            continue
        charge_id = charge_id_of(intent)
        log.info("Order %s: %s. %s", order["id"], reason, "would repair" if DRY_RUN else "repairing")
        if not DRY_RUN:
            apply_charge_id(order["id"], charge_id, intent_id)
        repaired += 1
    log.info("Done. %d order(s) %s.", repaired, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
