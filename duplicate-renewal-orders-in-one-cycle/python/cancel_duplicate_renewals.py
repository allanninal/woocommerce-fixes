"""Find duplicate renewal orders made for the same subscription in one billing
cycle, and cancel the extra one.

WooCommerce Subscriptions can create two renewal orders for a single period when
the scheduled renewal action fires twice, for example after Action Scheduler
retries a slow run, or a shop manager clicks "Process renewal" while the cron
copy is still mid flight. Both orders carry the same subscription id in their
_subscription_renewal meta and the same _subscription_renewal_date. This walks
recent renewal orders, groups them by (subscription id, renewal date), and for
every group bigger than one, keeps exactly one order and cancels the rest, but
only when the extra order was never actually paid. A renewal that Stripe really
charged is never touched here, that is a different problem (a real double
charge) with its own guide. Read only by default. Run on a schedule.
"""
import os
import logging
from collections import defaultdict

import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cancel_duplicate_renewals")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "3"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}
UNPAID_STATUSES = {"pending", "on-hold", "failed"}


def meta_value(order, key):
    for meta in order.get("meta_data") or []:
        if meta.get("key") == key:
            return meta.get("value")
    return None


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    value = meta_value(order, "_stripe_intent_id")
    if value:
        return value
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(order["total"]) * 100)


def renewal_key(order):
    """Group key for one billing cycle: the subscription plus its renewal date."""
    sub_id = meta_value(order, "_subscription_renewal")
    renewal_date = meta_value(order, "_subscription_renewal_date")
    if not sub_id or not renewal_date:
        return None
    return (str(sub_id), str(renewal_date))


def group_renewals(orders):
    """Group renewal orders by (subscription id, renewal date)."""
    groups = defaultdict(list)
    for order in orders:
        key = renewal_key(order)
        if key is not None:
            groups[key].append(order)
    return groups


def choose_keeper(group):
    """Pick the order to keep out of a duplicate group: a paid one if any exists,
    otherwise the oldest by id. Ties among paid orders also fall back to oldest id.
    """
    paid = [o for o in group if o["status"] in PAID_STATUSES]
    pool = paid if paid else group
    return min(pool, key=lambda o: o["id"])


def decide(group, intents_by_order_id=None):
    """Pure decision function: given one group of orders that share a subscription
    id and renewal date, return a list of (order, action, reason) tuples.

    intents_by_order_id is an optional dict mapping order id to a Stripe
    PaymentIntent dict (or None), used to double check an order marked paid
    really was charged before it is ever left alone as a "keeper" on that basis
    alone versus flagged as a mismatch. It defaults to an empty dict, in which
    case the decision relies only on WooCommerce order status.
    """
    intents_by_order_id = intents_by_order_id or {}
    if len(group) < 2:
        return [(group[0], "skip", "only one renewal order for this cycle")] if group else []

    keeper = choose_keeper(group)
    results = []
    for order in group:
        if order["id"] == keeper["id"]:
            results.append((order, "keep", "kept as the order for this billing cycle"))
            continue
        if order["status"] in PAID_STATUSES:
            intent = intents_by_order_id.get(order["id"])
            if intent is not None and intent.get("status") == "succeeded":
                # Two orders in the same cycle both look genuinely charged.
                # That is a real double charge, not a duplicate order to
                # cancel automatically. Flag it for a human instead.
                results.append((order, "flag", "both orders appear paid, needs manual review"))
                continue
            results.append((order, "flag", "marked paid but not confirmed by Stripe, needs manual review"))
            continue
        if order["status"] not in UNPAID_STATUSES:
            results.append((order, "skip", f"status {order['status']} is not safe to cancel automatically"))
            continue
        results.append((order, "cancel", "duplicate renewal order, never paid"))
    return results


def recent_renewal_orders(lookback_days):
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=lookback_days)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"after": after, "per_page": 100, "page": page, "orderby": "id", "order": "asc"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            if meta_value(order, "_subscription_renewal"):
                yield order
        page += 1


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def cancel_order(order, reason):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"status": "cancelled"},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Cancelled by the duplicate renewal cleanup: {reason}. "
                      f"This subscription already has another renewal order for the same cycle."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    groups = group_renewals(recent_renewal_orders(LOOKBACK_DAYS))
    cancelled = 0
    flagged = 0
    for key, group in groups.items():
        if len(group) < 2:
            continue
        sub_id, renewal_date = key
        intents_by_order_id = {
            order["id"]: get_intent(intent_id_of(order))
            for order in group
            if order["status"] in PAID_STATUSES
        }
        for order, action, reason in decide(group, intents_by_order_id):
            if action == "keep" or action == "skip":
                continue
            if action == "flag":
                log.warning("Subscription %s, order %s: %s", sub_id, order["id"], reason)
                flagged += 1
                continue
            log.info(
                "Subscription %s, renewal %s, order %s: %s. %s",
                sub_id, renewal_date, order["id"], reason, "would cancel" if DRY_RUN else "cancelling",
            )
            if not DRY_RUN:
                cancel_order(order, reason)
            cancelled += 1
    log.info(
        "Done. %d order(s) %s, %d flagged for manual review.",
        cancelled, "to cancel" if DRY_RUN else "cancelled", flagged,
    )


if __name__ == "__main__":
    run()
