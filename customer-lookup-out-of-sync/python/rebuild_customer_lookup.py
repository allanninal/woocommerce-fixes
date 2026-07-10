"""Rebuild WooCommerce customer lookup rows that have drifted from real orders.

The customer lookup table (orders_count, total_spent, last_order_date) is a cache
built from real orders. It is meant to update whenever an order is placed, paid,
refunded, or changes status, but a stuck scheduled action, a bulk import, or a
direct database edit can leave it holding stale numbers long after the real orders
moved on. This walks every customer, recalculates their real totals straight from
the WooCommerce REST API, compares that to the stored row, and rewrites only the
rows that disagree. It also checks whether the saved Stripe customer id on a
customer's most recent order still resolves, since a stale link is another common
form of the same drift. Safe by default (dry run). Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/customer-lookup-out-of-sync/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rebuild_customer_lookup")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
stripe.api_key = os.environ.get("STRIPE_SECRET_KEY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

COUNTED_STATUSES = {"processing", "completed"}


def all_customers():
    """Page through every WooCommerce customer."""
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/customers",
            params={"per_page": 50, "page": page}, auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for customer in batch:
            yield customer
        page += 1


def real_orders_for(customer_id):
    """Page through a customer's real (counted-status) orders."""
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"customer": customer_id, "per_page": 50, "page": page, "status": "any"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            if order["status"] in COUNTED_STATUSES:
                yield order
        page += 1


def order_amount_minor(order):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(order["total"]) * 100)


def recalc_from_orders(orders):
    """Pure: recompute the three lookup numbers from a list of real orders."""
    orders = list(orders)
    count = len(orders)
    total_minor = sum(order_amount_minor(o) for o in orders)
    last_order_date = max((o["date_created"] for o in orders), default=None)
    return {
        "orders_count": count,
        "total_spent_minor": total_minor,
        "last_order_date": last_order_date,
    }


def stored_totals_of(customer):
    """Pure: normalize a WooCommerce customer record into the same shape as recalc_from_orders."""
    return {
        "orders_count": customer.get("orders_count", 0),
        "total_spent_minor": round(float(customer.get("total_spent", "0") or "0") * 100),
        "last_order_date": customer.get("last_order_date"),
    }


def decide(stored, recalculated):
    """Pure decision function. No I/O. Compares stored totals to a fresh recalculation."""
    stored_count = stored.get("orders_count", 0)
    stored_total = stored.get("total_spent_minor", 0)
    stored_date = stored.get("last_order_date")

    same_count = stored_count == recalculated["orders_count"]
    same_total = abs(stored_total - recalculated["total_spent_minor"]) <= 1
    same_date = stored_date == recalculated["last_order_date"]

    if same_count and same_total and same_date:
        return ("skip", "lookup row already matches real orders")
    if recalculated["orders_count"] == 0 and stored_count > 0:
        return ("rebuild", "stored row has orders but no real paid orders were found")
    return ("rebuild", "stored row does not match real orders")


def stripe_customer_id_of(order):
    """Pure: read the saved Stripe customer id from order meta, or fall back to transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_customer_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("cus_") else None


def stripe_link_is_valid(customer_id):
    if not customer_id or not stripe.api_key:
        return False
    try:
        cust = stripe.Customer.retrieve(customer_id)
        return not cust.get("deleted", False)
    except stripe.error.InvalidRequestError:
        return False


def rebuild(customer_id, recalculated):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}",
        json={"meta_data": [
            {"key": "orders_count", "value": recalculated["orders_count"]},
            {"key": "total_spent", "value": str(recalculated["total_spent_minor"] / 100)},
            {"key": "last_order_date", "value": recalculated["last_order_date"]},
        ]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    rebuilt = 0
    for customer in all_customers():
        orders = list(real_orders_for(customer["id"]))
        recalculated = recalc_from_orders(orders)
        stored = stored_totals_of(customer)
        action, reason = decide(stored, recalculated)
        if action == "skip":
            continue

        stripe_note = ""
        if orders:
            cust_id = stripe_customer_id_of(orders[-1])
            if cust_id and not stripe_link_is_valid(cust_id):
                stripe_note = f" Saved Stripe customer id {cust_id} no longer resolves."

        log.info(
            "Customer %s: %s.%s %s",
            customer["id"], reason, stripe_note,
            "would rebuild" if DRY_RUN else "rebuilding",
        )
        if not DRY_RUN:
            rebuild(customer["id"], recalculated)
        rebuilt += 1
    log.info("Done. %d customer(s) %s.", rebuilt, "to rebuild" if DRY_RUN else "rebuilt")


if __name__ == "__main__":
    run()
