"""Find WooCommerce orders that were charged twice because a retry went out
without a Stripe Idempotency-Key.

A flaky network, a page refresh, or a double-click on "Place order" can send
the same checkout request twice. When neither request carries the same
Idempotency-Key, Stripe treats them as two different payments and can create
two separate PaymentIntents, both of which succeed. WooCommerce only stores
one PaymentIntent id on the order, so the extra charge is invisible unless you
go looking for it in Stripe.

This script reads the PaymentIntent id saved on each recent paid order (meta
_stripe_intent_id, falling back to transaction_id), looks up that intent's
Stripe Customer, and lists every other succeeded PaymentIntent created for
that same customer within a short window with the same amount. Anything it
finds beyond the one saved on the order is a likely duplicate charge.

Read only by default. Refunding is a separate, explicit step you take after
reviewing the report, never automatic.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_intents")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
MATCH_WINDOW_MINUTES = int(os.environ.get("MATCH_WINDOW_MINUTES", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(order["total"]) * 100)


def find_candidate_duplicates(primary_intent, other_intents, order_amount_minor_value, window_seconds):
    """Pure decision function. No I/O.

    primary_intent: the PaymentIntent whose id is saved on the order.
    other_intents: every other succeeded PaymentIntent for the same customer,
        as plain dicts with at least id, status, amount_received, created.
    order_amount_minor_value: the order total in minor units (cents).
    window_seconds: how close in time a second charge has to be to count.

    Returns a list of (intent_dict, reason) tuples, one per likely duplicate.
    An intent only counts as a duplicate when it succeeded, is not the
    primary intent, matches the order amount, and was created within the
    time window of the primary intent.
    """
    duplicates = []
    if primary_intent is None or primary_intent.get("status") != "succeeded":
        return duplicates
    primary_created = primary_intent.get("created", 0)
    for candidate in other_intents:
        if candidate.get("id") == primary_intent.get("id"):
            continue
        if candidate.get("status") != "succeeded":
            continue
        if abs(candidate.get("amount_received", 0) - order_amount_minor_value) > 1:
            continue
        if abs(candidate.get("created", 0) - primary_created) > window_seconds:
            continue
        duplicates.append((candidate, "same customer, same amount, created within the match window"))
    return duplicates


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def other_succeeded_for_customer(customer_id, exclude_intent_id, lookback_days):
    if not customer_id:
        return []
    since = int(__import__("time").time()) - lookback_days * 86400
    results = []
    for intent in stripe.PaymentIntent.list(
        customer=customer_id, limit=100, created={"gte": since}
    ).auto_paging_iter():
        if intent.id == exclude_intent_id:
            continue
        if intent.status == "succeeded":
            results.append(intent)
    return results


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


def flag(order, duplicate_intent_ids):
    note = (
        "Possible duplicate charge detected. This order's saved PaymentIntent "
        "succeeded, but Stripe also shows " + ", ".join(duplicate_intent_ids) +
        " as succeeded for the same customer, amount, and time window. "
        "This can happen when a retry goes out without an Idempotency-Key. "
        "Please review in Stripe before refunding."
    )
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": note},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    flagged = 0
    for order in paid_orders(LOOKBACK_DAYS):
        if order["status"] not in PAID_STATUSES:
            continue
        primary = get_intent(intent_id_of(order))
        if primary is None:
            continue
        customer_id = primary.get("customer")
        others = other_succeeded_for_customer(customer_id, primary["id"], LOOKBACK_DAYS)
        others_as_dicts = [dict(o) for o in others]
        duplicates = find_candidate_duplicates(
            dict(primary), others_as_dicts, order_amount_minor(order), MATCH_WINDOW_MINUTES * 60
        )
        if not duplicates:
            continue
        duplicate_ids = [d["id"] for d, _reason in duplicates]
        log.warning(
            "Order %s: %d likely duplicate charge(s) found: %s. %s",
            order["id"], len(duplicate_ids), ", ".join(duplicate_ids),
            "would flag" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag(order, duplicate_ids)
        flagged += 1
    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
