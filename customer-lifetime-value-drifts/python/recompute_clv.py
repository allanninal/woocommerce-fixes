"""Recompute WooCommerce customer lifetime value from real paid orders.

WooCommerce caches a customer's lifetime value (report_customer meta and the
Analytics customers table) instead of summing orders on every page view. That
cache can drift from reality: a refund that never re-synced, an order edited
after the total was cached, or a Stripe refund issued from the Stripe
dashboard that never reached WooCommerce at all. This walks each customer's
paid orders, nets out refunds using the WooCommerce REST API, double checks
the refund total against Stripe when a PaymentIntent id is on the order, and
writes the correct lifetime value back onto the customer as meta. Read only
by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recompute_clv")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRIFT_TOLERANCE_CENTS = int(os.environ.get("DRIFT_TOLERANCE_CENTS", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}
CLV_META_KEY = "_clv_recomputed_cents"


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_total_minor(order):
    return round(float(order["total"]) * 100)


def order_refunded_minor(order):
    # WooCommerce reports the running refund total as a negative string on the order.
    total_refunded = order.get("refunds")
    if total_refunded:
        return sum(round(abs(float(r.get("total", 0))) * 100) for r in total_refunded)
    return round(abs(float(order.get("total_refunded", "0") or 0)) * 100)


def net_order_value_minor(order):
    """What this order actually contributed to lifetime value, after refunds."""
    return max(0, order_total_minor(order) - order_refunded_minor(order))


def stripe_refunded_minor(intent):
    """Sum of refunds Stripe knows about for the charge behind a PaymentIntent."""
    if intent is None:
        return None
    charge = intent.get("latest_charge_obj")
    if charge is None:
        return None
    return charge.get("amount_refunded", 0)


def compute_customer_clv(orders, stripe_refunds_by_order_id=None):
    """Pure: sum the net value of every paid order for one customer.

    orders: list of WooCommerce order dicts for a single customer.
    stripe_refunds_by_order_id: optional {order_id: refunded_minor_units} to
        prefer Stripe's refund total over WooCommerce's cached one, when it is
        available and larger (Stripe is the source of truth for money moving
        back to the buyer).
    Returns (total_minor, order_count, notes) where notes lists any orders
    where WooCommerce and Stripe disagreed on the refunded amount.
    """
    stripe_refunds_by_order_id = stripe_refunds_by_order_id or {}
    total = 0
    counted = 0
    notes = []
    for order in orders:
        if order.get("status") not in PAID_STATUSES:
            continue
        woo_refunded = order_refunded_minor(order)
        stripe_refunded = stripe_refunds_by_order_id.get(order["id"])
        refunded = woo_refunded
        if stripe_refunded is not None and stripe_refunded > woo_refunded:
            notes.append(
                f"order {order['id']}: Stripe shows {stripe_refunded} minor units refunded, "
                f"WooCommerce cache shows {woo_refunded}; using Stripe's figure"
            )
            refunded = stripe_refunded
        net = max(0, order_total_minor(order) - refunded)
        total += net
        counted += 1
    return total, counted, notes


def decide(customer, computed_total_minor, tolerance_cents=DRIFT_TOLERANCE_CENTS):
    """Pure: compare WooCommerce's cached lifetime value to the recomputed one.

    customer: dict with at least "total_spent" (WooCommerce's cached string,
        the same field the Analytics report and the customer list show).
    Returns (action, reason). action is one of "ok", "drift", "no_orders".
    """
    cached_minor = round(float(customer.get("total_spent") or 0) * 100)
    if computed_total_minor == 0 and cached_minor == 0:
        return ("no_orders", "no paid orders and no cached value")
    if abs(cached_minor - computed_total_minor) <= tolerance_cents:
        return ("ok", "cached lifetime value matches recomputed orders")
    direction = "higher" if cached_minor > computed_total_minor else "lower"
    return (
        "drift",
        f"cached lifetime value ({cached_minor}) is {direction} than the recomputed "
        f"total from paid orders ({computed_total_minor})",
    )


def list_customers():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/customers",
            params={"per_page": 50, "page": page, "orderby": "id"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for customer in batch:
            yield customer
        page += 1


def list_orders_for_customer(customer_id):
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"customer": customer_id, "per_page": 100, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def get_stripe_refunded_minor(order):
    intent_id = intent_id_of(order)
    if not intent_id:
        return None
    try:
        intent = stripe.PaymentIntent.retrieve(intent_id, expand=["latest_charge"])
    except stripe.error.InvalidRequestError:
        return None
    charge = intent.get("latest_charge")
    if not charge or not isinstance(charge, dict):
        return None
    return charge.get("amount_refunded")


def write_lifetime_value(customer_id, total_minor):
    dollars = f"{total_minor / 100:.2f}"
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}",
        json={"meta_data": [{"key": CLV_META_KEY, "value": dollars}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    drifted = 0
    checked = 0
    for customer in list_customers():
        orders = list(list_orders_for_customer(customer["id"]))
        stripe_refunds = {}
        for order in orders:
            if order.get("status") in PAID_STATUSES:
                refunded = get_stripe_refunded_minor(order)
                if refunded is not None:
                    stripe_refunds[order["id"]] = refunded
        total_minor, counted, notes = compute_customer_clv(orders, stripe_refunds)
        checked += 1
        action, reason = decide(customer, total_minor)
        for note in notes:
            log.info("Customer %s: %s", customer["id"], note)
        if action != "drift":
            continue
        log.warning(
            "Customer %s (%s paid orders): %s. %s",
            customer["id"], counted, reason, "would write" if DRY_RUN else "writing",
        )
        if not DRY_RUN:
            write_lifetime_value(customer["id"], total_minor)
        drifted += 1
    log.info("Done. Checked %d customer(s). %d %s.", checked, drifted, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
