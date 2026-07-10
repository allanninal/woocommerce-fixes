"""Release WooCommerce stock reservations that have gone stale.

WooCommerce holds stock for an order the moment checkout starts, before payment
is confirmed. The hold is meant to expire on its own, but a crashed checkout, a
timed out payment page, or a queue worker that never ran can leave the order on
pending or checkout-draft long after the hold window passed. The reservation
row is now stale: the item still looks sold to the stock count, even though no
payment ever completed for it, so a second buyer can be oversold the same
units. This walks recent unpaid orders, checks each one's age and its Stripe
PaymentIntent, and cancels the order (which releases the stock hold) only when
the hold is expired and Stripe confirms no payment ever came through. Safe to
run again and again. Read only until DRY_RUN is turned off.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("release_stale_reservations")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
HOLD_MINUTES = int(os.environ.get("HOLD_MINUTES", "60"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Orders in these statuses still hold stock but have not paid.
HOLDING_STATUSES = {"pending", "checkout-draft"}
PAID_INTENT_STATUSES = {"succeeded"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def minutes_since(iso_date_string, now=None):
    """Minutes elapsed since an ISO 8601 timestamp (no timezone math needed for GMT dates)."""
    now = time.time() if now is None else now
    parsed = time.strptime(iso_date_string.split(".")[0], "%Y-%m-%dT%H:%M:%S")
    then = time.mktime(parsed) - time.timezone
    return (now - then) / 60


def decide(order, intent, age_minutes, hold_minutes=HOLD_MINUTES):
    """Pure decision: what should happen to one held order? No I/O in here.

    order        - dict from GET /orders/{id} (or a plain test double)
    intent       - Stripe PaymentIntent dict, or None if the order never got one
    age_minutes  - minutes since the order was created (caller computes this)
    hold_minutes - how long a reservation is allowed to sit before it is stale
    """
    if order["status"] not in HOLDING_STATUSES:
        return ("skip", "order is not in a stock-holding status")
    if age_minutes < hold_minutes:
        return ("skip", "reservation has not expired yet")
    if intent is not None and intent.get("status") in PAID_INTENT_STATUSES:
        return ("paid", "Stripe shows this order was actually paid, do not touch stock")
    return ("release", "reservation is stale and was never paid")


def order_age_minutes(order):
    return minutes_since(order["date_created_gmt"] or order["date_created"])


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def held_orders():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "pending,checkout-draft", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def release(order):
    """Cancel the order. WooCommerce releases the reserved stock row as part of
    the normal cancel flow, the same way it would if a customer walked away.
    """
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"status": "cancelled"}, auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": "Stock reservation released: this order sat unpaid past the hold "
                      "window and Stripe confirms no successful payment. Cancelled so the "
                      "held stock is freed for other buyers."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    released = 0
    for order in held_orders():
        age_minutes = order_age_minutes(order)
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent, age_minutes)
        if action != "release":
            if action == "paid":
                log.warning("Order %s: %s", order["id"], reason)
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would release" if DRY_RUN else "releasing")
        if not DRY_RUN:
            release(order)
        released += 1
    log.info("Done. %d order(s) %s.", released, "to release" if DRY_RUN else "released")


if __name__ == "__main__":
    run()
