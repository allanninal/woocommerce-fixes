"""Backfill the Stripe fee and net on WooCommerce Subscriptions renewal orders
that are missing them, usually because an update stopped a fee-saving hook
from firing on renewals. Read only by default. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/fee-and-net-missing-on-renewals/
"""
import os
import datetime
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_renewal_fees")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FEE_META_KEY = "_stripe_fee"
NET_META_KEY = "_stripe_net"
PAID_STATUSES = {"processing", "completed"}


def is_renewal_order(order):
    """A renewal order carries a _subscription_renewal meta key pointing at the parent subscription."""
    return any(m.get("key") == "_subscription_renewal" for m in order.get("meta_data") or [])


def has_fee_and_net(order):
    keys = {m.get("key") for m in order.get("meta_data") or []}
    return FEE_META_KEY in keys and NET_META_KEY in keys


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(order, balance_transaction):
    """Pure decision: what should happen to this renewal order? No I/O here.

    Returns a (action, reason) tuple. action is one of:
      "skip"   - nothing to do
      "orphan" - looks broken in a way a human should check
      "fix"    - write the fee and net back onto the order
    """
    if not is_renewal_order(order):
        return ("skip", "not a renewal order")
    if order["status"] not in PAID_STATUSES:
        return ("skip", "renewal not paid yet")
    if has_fee_and_net(order):
        return ("skip", "fee and net already recorded")
    if not intent_id_of(order):
        return ("orphan", "no PaymentIntent id saved on the order")
    if balance_transaction is None:
        return ("orphan", "no balance transaction found for the charge")
    fee = balance_transaction.get("fee")
    net = balance_transaction.get("net")
    if fee is None or net is None:
        return ("orphan", "balance transaction missing fee or net")
    return ("fix", "renewal paid, fee and net can be backfilled")


def to_major(minor_amount):
    """Convert a minor unit amount (cents) to a 2-decimal major unit amount."""
    return round(minor_amount / 100, 2)


def balance_transaction_for(intent_id):
    if not intent_id:
        return None
    try:
        pi = stripe.PaymentIntent.retrieve(intent_id, expand=["latest_charge.balance_transaction"])
    except stripe.error.InvalidRequestError:
        return None
    charge = pi.get("latest_charge")
    if not charge or isinstance(charge, str):
        return None
    bt = charge.get("balance_transaction")
    if not bt or isinstance(bt, str):
        return None
    return bt


def paid_renewal_orders():
    after = f"{datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    page = 1
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
            if is_renewal_order(order):
                yield order
        page += 1


def save_fee_and_net(order_id, fee_minor, net_minor):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"meta_data": [
            {"key": FEE_META_KEY, "value": f"{to_major(fee_minor):.2f}"},
            {"key": NET_META_KEY, "value": f"{to_major(net_minor):.2f}"},
        ]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Backfilled Stripe fee {to_major(fee_minor):.2f} and net "
                      f"{to_major(net_minor):.2f} for this renewal. Recorded by the fee backfill."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    orphans = 0
    for order in paid_renewal_orders():
        intent_id = intent_id_of(order)
        bt = balance_transaction_for(intent_id)
        action, reason = decide(order, bt)
        if action == "orphan":
            log.warning("Order %s: %s", order["id"], reason)
            orphans += 1
            continue
        if action == "skip":
            continue
        fee_minor, net_minor = bt["fee"], bt["net"]
        log.info("Order %s: fee %.2f net %.2f. %s", order["id"], to_major(fee_minor), to_major(net_minor),
                 "would save" if DRY_RUN else "saving")
        if not DRY_RUN:
            save_fee_and_net(order["id"], fee_minor, net_minor)
        fixed += 1
    log.info("Done. %d order(s) %s, %d orphan(s) need a manual look.",
              fixed, "to backfill" if DRY_RUN else "backfilled", orphans)


if __name__ == "__main__":
    run()
