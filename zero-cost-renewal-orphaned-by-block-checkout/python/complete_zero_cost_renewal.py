"""Finish zero cost WooCommerce Subscriptions renewal orders orphaned by block checkout.

When a renewal nets to $0.00 (a 100% off coupon, a switch credit, a free trial that
converted with a balance still applied) WooCommerce skips Stripe entirely, since
there is nothing to charge. The classic checkout flow still calls
`payment_complete()` on the order for a $0 total. The block checkout flow does not
run that step for zero cost renewals, so the renewal order is created and then just
sits on Pending or On hold, no Stripe PaymentIntent is ever attached, no renewal
note is added, and the subscription's next payment date is never advanced.

This script finds renewal orders that are genuinely zero cost, still unpaid, and
have no Stripe PaymentIntent on them (because none was ever needed), and completes
them the way `payment_complete()` would have. It never touches an order that has a
real PaymentIntent attached or a non-zero total, those belong to a different fix.
Read the order list from the WooCommerce REST API. Safe to run again and again.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("complete_zero_cost_renewal")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

UNPAID_STATUSES = {"pending", "on-hold"}
ZERO_COST_TOLERANCE_MINOR = 1  # a cent of rounding slack, same idea as the other guides


def order_total_minor(order):
    """Order total in minor units (cents). Keep money math in integers."""
    return round(float(order["total"]) * 100)


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def is_renewal_order(order):
    """Renewal orders carry the subscription renewal meta WooCommerce Subscriptions writes."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_subscription_renewal" and meta.get("value"):
            return True
    return False


def created_via(order):
    return (order.get("created_via") or "").lower()


def decide(order):
    """Pure decision: should this renewal order be completed as a zero cost renewal?

    Returns a tuple of (action, reason). No I/O, no Stripe or Woo calls, just the
    order dict already on hand, so this is trivial to unit test.
    """
    if not is_renewal_order(order):
        return ("skip", "not a subscription renewal order")
    if order["status"] not in UNPAID_STATUSES:
        return ("skip", "order is not pending or on-hold")
    if order_total_minor(order) > ZERO_COST_TOLERANCE_MINOR:
        return ("skip", "order total is not zero cost")
    if intent_id_of(order) is not None:
        # A PaymentIntent exists, so this is a stuck payment case, not an orphaned
        # zero cost renewal. That belongs to the "paid orders stuck on pending" fix.
        return ("skip", "a Stripe PaymentIntent is attached, not a zero cost orphan")
    if created_via(order) not in ("checkout", "subscription", ""):
        # Unexpected origin, safer to leave it for a human to check.
        return ("review", "unexpected created_via, check manually")
    return ("complete", "zero cost renewal with no PaymentIntent, safe to complete")


def renewal_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "pending,on-hold", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def complete_renewal(order):
    """Finish the order the way payment_complete() would for a $0 renewal."""
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"status": "processing", "set_paid": True},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": "Completed by the zero cost renewal script. This renewal totaled "
                      "$0.00 and had no Stripe PaymentIntent, so it was never finished by "
                      "the block checkout flow. Marked processing and paid."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for order in renewal_orders():
        action, reason = decide(order)
        if action == "review":
            log.warning("Order %s: %s", order["id"], reason)
            continue
        if action != "complete":
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would complete" if DRY_RUN else "completing")
        if not DRY_RUN:
            complete_renewal(order)
        fixed += 1
    log.info("Done. %d order(s) %s.", fixed, "to complete" if DRY_RUN else "completed")


if __name__ == "__main__":
    run()
