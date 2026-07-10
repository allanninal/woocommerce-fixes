"""Detect WooCommerce Subscriptions switch orders with a miscalculated proration.

A second switch inside the same billing cycle should prorate against the
price the first switch already set, but the calculation can instead reuse
the subscription's price from before either switch happened. This walks
recent switch orders, rebuilds what the proration should have been from the
subscription's own order history and plan prices, and flags any switch
order whose total, or the linked Stripe charge, does not match. Read only
by default. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/proration-miscalculated-on-a-second-switch/
"""
import os
import datetime
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_switch_proration")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def meta(order, key):
    for m in order.get("meta_data") or []:
        if m.get("key") == key:
            return m.get("value")
    return None


def to_minor(amount):
    """Convert a decimal money string like '19.99' to minor units (cents)."""
    return round(float(amount) * 100)


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for m in order.get("meta_data") or []:
        if m.get("key") == "_stripe_intent_id" and m.get("value"):
            return m["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def recent_switch_orders(lookback_days):
    """Yield orders in the lookback window that carry the switch order meta key."""
    after = (datetime.date.today() - datetime.timedelta(days=lookback_days)).isoformat() + "T00:00:00"
    page = 1
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
            if meta(order, "_subscription_switch"):
                yield order
        page += 1


def subscription_orders(subscription_id):
    """All orders that belong to a subscription, oldest first."""
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"subscription": subscription_id, "per_page": 100, "orderby": "date", "order": "asc"},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def cycle_for_switch(switch_order, prior_orders):
    """Build the cycle inputs a real store would read from the subscription's own
    next payment date and line item history. The switch order carries days
    remaining and days in cycle as meta at the time it was created; the old
    price is the total of the most recent prior order on the subscription.
    """
    old_price_minor = to_minor(prior_orders[-1]["total"]) if prior_orders else 0
    new_price_minor = to_minor(switch_order["total"]) if not prior_orders else old_price_minor
    return {
        "days_remaining": int(meta(switch_order, "_switch_days_remaining") or 0),
        "days_in_cycle": int(meta(switch_order, "_switch_days_in_cycle") or 30),
        "old_price_minor": old_price_minor,
        "new_price_minor": new_price_minor,
    }


def expected_proration_minor(days_remaining, days_in_cycle, old_price_minor, new_price_minor):
    """What the switch should cost: the new plan's daily rate minus the old
    plan's daily rate, times the days left in the cycle. Negative means a credit.
    All amounts are in minor units (cents) to avoid float drift.
    """
    if days_in_cycle <= 0:
        return 0
    daily_delta = (new_price_minor - old_price_minor) / days_in_cycle
    return round(daily_delta * days_remaining)


def decide(switch_order, prior_orders_total_minor, cycle, stripe_amount_minor):
    """Pure decision function, no I/O.

    cycle = {"days_remaining": int, "days_in_cycle": int,
             "old_price_minor": int, "new_price_minor": int}
    prior_orders_total_minor: sum already collected this cycle from earlier
        orders against this subscription (renewal or prior switch), in cents.
        Kept as an explicit argument so a caller can pass a different prior
        total without changing the cycle shape.
    stripe_amount_minor: amount_received on the linked PaymentIntent, or
        None if no charge was made (a pure credit switch).

    Returns (action, reason, expected_minor). action is "ok" when the switch
    order total and the Stripe charge both agree with the recomputed
    proration, otherwise "flag".
    """
    order_total_minor = to_minor(switch_order["total"])
    expected = expected_proration_minor(
        cycle["days_remaining"], cycle["days_in_cycle"],
        cycle["old_price_minor"], cycle["new_price_minor"],
    )
    order_matches = abs(order_total_minor - expected) <= 1
    stripe_matches = stripe_amount_minor is None or abs(stripe_amount_minor - max(expected, 0)) <= 1
    if order_matches and stripe_matches:
        return ("ok", "switch order matches the expected proration", expected)
    return ("flag", "switch order does not match the expected proration", expected)


def flag_order(order_id, expected_minor, order_total_minor, stripe_amount_minor):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": (
            "Proration check failed on this switch order. "
            f"Expected proration: {expected_minor} cents. "
            f"Order total: {order_total_minor} cents. "
            f"Stripe charged: {stripe_amount_minor if stripe_amount_minor is not None else 'no charge'} cents. "
            "Please review before issuing a credit or a follow up charge."
        )},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    flagged = 0
    for switch_order in recent_switch_orders(LOOKBACK_DAYS):
        subscription_id = meta(switch_order, "_subscription_switch")
        prior_orders = [
            o for o in subscription_orders(subscription_id) if o["id"] != switch_order["id"]
        ]
        cycle = cycle_for_switch(switch_order, prior_orders)
        prior_total_minor = sum(to_minor(o["total"]) for o in prior_orders)
        intent = get_intent(intent_id_of(switch_order))
        stripe_amount_minor = intent.get("amount_received") if intent else None
        action, reason, expected = decide(switch_order, prior_total_minor, cycle, stripe_amount_minor)
        if action != "flag":
            continue
        order_total_minor = to_minor(switch_order["total"])
        log.warning(
            "Order %s: %s (expected %d, got %d). %s",
            switch_order["id"], reason, expected, order_total_minor,
            "would flag" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag_order(switch_order["id"], expected, order_total_minor, stripe_amount_minor)
        flagged += 1
    log.info("Done. %d switch order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
