"""Recompute stale Stripe fee and net on refunded WooCommerce orders.
Reporting only. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/stripe-fee-net-stale-after-refund/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_fee_net")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def recompute_net_fee(charge_bt, refund_bts):
    net = charge_bt["net"]
    fee = charge_bt["fee"]
    for bt in refund_bts:
        net += bt["net"]
        fee += bt["fee"]
    return net, fee


def is_stale(saved_minor, true_minor, tolerance=1):
    return abs(saved_minor - true_minor) > tolerance


def get_meta(order, key):
    for m in order.get("meta_data", []):
        if m.get("key") == key:
            return m.get("value")
    return None


def to_minor(value):
    try:
        return round(float(value) * 100)
    except (TypeError, ValueError):
        return None


def paid_stripe_orders():
    page = 1
    while True:
        r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders",
                         params={"status": "processing,completed,refunded", "per_page": 50, "page": page},
                         auth=AUTH, timeout=30)
        r.raise_for_status()
        orders = r.json()
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def charge_numbers(charge_id):
    charge = stripe.Charge.retrieve(
        charge_id, expand=["balance_transaction", "refunds.data.balance_transaction"])
    charge_bt = charge["balance_transaction"]
    refund_bts = [r["balance_transaction"] for r in charge["refunds"]["data"] if r.get("balance_transaction")]
    return charge_bt, refund_bts


def add_note(order_id, note):
    requests.post(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
                  json={"note": note}, auth=AUTH, timeout=30).raise_for_status()


def write_back(order_id, net_minor, fee_minor):
    requests.put(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
                 json={"meta_data": [
                     {"key": "_stripe_net", "value": f"{net_minor / 100:.2f}"},
                     {"key": "_stripe_fee", "value": f"{fee_minor / 100:.2f}"},
                 ]}, auth=AUTH, timeout=30).raise_for_status()
    add_note(order_id, f"Recomputed Stripe fee and net after refund: net {net_minor / 100:.2f}, "
                       f"fee {fee_minor / 100:.2f}.")


def run():
    fixed = 0
    for order in paid_stripe_orders():
        charge_id = get_meta(order, "_stripe_charge_id")
        if not charge_id:
            continue
        charge_bt, refund_bts = charge_numbers(charge_id)
        if not charge_bt or not refund_bts:
            continue
        true_net, true_fee = recompute_net_fee(charge_bt, refund_bts)
        saved_net = to_minor(get_meta(order, "_stripe_net"))
        saved_fee = to_minor(get_meta(order, "_stripe_fee"))
        if saved_net is not None and not is_stale(saved_net, true_net) \
                and saved_fee is not None and not is_stale(saved_fee, true_fee):
            continue
        log.info("Order %s: net %s -> %s, fee %s -> %s. %s",
                 order["id"], saved_net, true_net, saved_fee, true_fee, "dry run" if DRY_RUN else "fixing")
        if not DRY_RUN:
            write_back(order["id"], true_net, true_fee)
        fixed += 1
    log.info("Done. %d order(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
