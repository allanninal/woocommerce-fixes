"""Find WooCommerce orders charged twice on Stripe and refund the extra charge.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/duplicate-charge-redirect-webhook-race/
"""
import os
import time
import logging
from collections import defaultdict
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("refund_duplicates")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "48"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def recent_charges(lookback_hours):
    since = int(time.time()) - lookback_hours * 3600
    return stripe.Charge.list(limit=100, created={"gte": since}).auto_paging_iter()


def duplicate_sets(charges):
    by_order = defaultdict(list)
    for ch in charges:
        oid = (ch.get("metadata") or {}).get("order_id")
        if oid and ch.get("status") == "succeeded" and not ch.get("refunded"):
            by_order[oid].append(ch)
    duplicates = {}
    for oid, group in by_order.items():
        by_amount = defaultdict(list)
        for ch in group:
            by_amount[ch["amount"]].append(ch)
        for amount, same in by_amount.items():
            if len(same) > 1:
                duplicates[(oid, amount)] = same
    return duplicates


def order_transaction_id(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json().get("transaction_id")


def choose_extras(same, order_transaction):
    keeper = next((c for c in same if c["id"] == order_transaction), None)
    if keeper is None:
        keeper = min(same, key=lambda c: c["created"])
    return [c for c in same if c["id"] != keeper["id"]]


def add_note(order_id, note):
    requests.post(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
                  json={"note": note}, auth=AUTH, timeout=30).raise_for_status()


def run():
    charges = list(recent_charges(LOOKBACK_HOURS))
    duplicates = duplicate_sets(charges)
    refunded = 0
    for (order_id, amount), same in duplicates.items():
        extras = choose_extras(same, order_transaction_id(order_id))
        for charge in extras:
            log.info("Order %s: duplicate charge %s for %s. %s",
                     order_id, charge["id"], amount, "would refund" if DRY_RUN else "refunding")
            if not DRY_RUN:
                stripe.Refund.create(charge=charge["id"], reason="duplicate")
                add_note(order_id, f"Refunded duplicate Stripe charge {charge['id']} "
                                   f"({charge['amount']} {charge['currency']}). Kept the charge on the order.")
            refunded += 1
    log.info("Done. %d duplicate charge(s) %s.", refunded, "to refund" if DRY_RUN else "refunded")


if __name__ == "__main__":
    run()
