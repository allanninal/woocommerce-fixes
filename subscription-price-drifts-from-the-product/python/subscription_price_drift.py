"""Find WooCommerce Subscriptions whose recurring price no longer matches the
product they were created from.

A product's regular price is changed, but every subscription already running
keeps billing at the price it was created with. That is normal and expected
for the customer's own subscription. The bug this script catches is a
subscription whose *stored* line item silently disagrees with what
WooCommerce itself would charge for that product today combined with what
Stripe actually billed on the last renewal, which usually means an admin
edit, an import, or a currency or tax change left the row inconsistent.

Read only by default. It reports every subscription whose line item price
does not agree with the last Stripe charge for that same subscription, and
can optionally realign the stored line item to match Stripe (the true
record of what was billed) rather than the product's current price, since
grandfathered pricing is intentional.

Run on a schedule, for example once a day.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("subscription_price_drift")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRIFT_TOLERANCE_CENTS = int(os.environ.get("DRIFT_TOLERANCE_CENTS", "1"))
AUTO_REPAIR = os.environ.get("AUTO_REPAIR", "false").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_STATUSES = {"active", "on-hold", "pending-cancel"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def line_item_total_minor(subscription):
    """The recurring total WooCommerce has stored on the subscription's line items,
    in minor units (cents). Uses the subscription total, which already folds in
    the line item price, any recurring coupon, and tax."""
    return round(float(subscription["total"]) * 100)


def last_charge_amount_minor(intent):
    """What Stripe actually collected for the last renewal, in cents."""
    if intent is None:
        return None
    return intent.get("amount_received", intent.get("amount"))


def decide(subscription, last_order, intent):
    """Pure decision function. No I/O. Returns (action, reason).

    subscription: a WooCommerce Subscriptions REST object (has "status", "total").
    last_order: the most recent renewal/parent order dict for this subscription,
                or None if there is no completed order to check yet.
    intent: the Stripe PaymentIntent dict for that order's stored intent id,
            or None if it could not be found.
    """
    if subscription["status"] not in ACTIVE_STATUSES:
        return ("skip", "subscription is not active")
    if last_order is None:
        return ("skip", "no billed order yet to compare against")
    if intent is None:
        return ("skip", "no matching Stripe PaymentIntent for the last order")
    if intent.get("status") != "succeeded":
        return ("skip", "last PaymentIntent did not succeed")

    sub_total = line_item_total_minor(subscription)
    charged = last_charge_amount_minor(intent)
    if charged is None:
        return ("skip", "Stripe intent has no charged amount")

    if abs(sub_total - charged) <= DRIFT_TOLERANCE_CENTS:
        return ("ok", "subscription total matches the last Stripe charge")

    if sub_total > charged:
        return ("drift_under_charged", "subscription total is higher than what Stripe last billed")
    return ("drift_over_charged", "subscription total is lower than what Stripe last billed")


def is_drift(action):
    return action in ("drift_under_charged", "drift_over_charged")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def active_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active,on-hold,pending-cancel", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for subscription in batch:
            yield subscription
        page += 1


def get_last_order(subscription):
    """The most recent renewal order, or the parent order if there has been no
    renewal yet."""
    related = subscription.get("last_order_id") or subscription.get("parent_id")
    if not related:
        return None
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{related}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def report(subscription, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{subscription['id']}/notes",
        json={"note": f"Price drift check: {reason}. The stored subscription total no "
                      f"longer matches what Stripe last charged for it. Please review "
                      f"before the next renewal."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def repair(subscription, intent):
    """Realign the stored line item subtotal/total on the subscription to match
    what Stripe actually collected last time, so the next renewal is
    consistent with what the customer has been paying. This never touches
    past orders, only the subscription's own recurring line item."""
    charged = last_charge_amount_minor(intent)
    new_total = f"{charged / 100:.2f}"
    line_items = subscription.get("line_items") or []
    if not line_items:
        return
    first_item_id = line_items[0]["id"]
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription['id']}",
        json={
            "line_items": [{"id": first_item_id, "subtotal": new_total, "total": new_total}],
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    drifted = 0
    for subscription in active_subscriptions():
        last_order = get_last_order(subscription)
        intent = get_intent(intent_id_of(last_order)) if last_order else None
        action, reason = decide(subscription, last_order, intent)
        if not is_drift(action):
            continue
        drifted += 1
        log.warning(
            "Subscription %s: %s. %s",
            subscription["id"], reason, "would report" if DRY_RUN else "reporting",
        )
        if not DRY_RUN:
            report(subscription, reason)
            if AUTO_REPAIR:
                repair(subscription, intent)
    log.info("Done. %d subscription(s) %s.", drifted, "to report" if DRY_RUN else "reported")


if __name__ == "__main__":
    run()
