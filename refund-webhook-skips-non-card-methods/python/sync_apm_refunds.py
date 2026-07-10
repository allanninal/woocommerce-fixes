"""Record Stripe refunds on non-card methods that the webhook skipped, and mark
fully refunded orders as Refunded. Uses api_refund false, never refunds twice.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/refund-webhook-skips-non-card-methods/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync_apm_refunds")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def is_stripe_apm(payment_method):
    return payment_method.startswith("stripe_")


def refund_action(order_total_minor, stripe_refunded_minor, wc_refunded_minor):
    missing = max(0, stripe_refunded_minor - wc_refunded_minor)
    fully = stripe_refunded_minor >= order_total_minor and stripe_refunded_minor > 0
    return missing, fully


def get_meta(order, key):
    for m in order.get("meta_data", []):
        if m.get("key") == key:
            return m.get("value")
    return None


def paid_stripe_orders():
    page = 1
    while True:
        r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders",
                         params={"status": "processing,completed", "per_page": 50, "page": page},
                         auth=AUTH, timeout=30)
        r.raise_for_status()
        orders = r.json()
        if not orders:
            return
        for order in orders:
            yield order
        page += 1


def stripe_refunded_minor(order):
    charge_id = get_meta(order, "_stripe_charge_id")
    if not charge_id:
        return 0
    return stripe.Charge.retrieve(charge_id).get("amount_refunded", 0)


def wc_refunded_minor(order):
    return sum(round(abs(float(r["total"])) * 100) for r in order.get("refunds", []))


def put_order(order_id, body):
    requests.put(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", json=body, auth=AUTH, timeout=30).raise_for_status()


def record_and_mark(order_id, missing_minor, fully):
    if missing_minor > 0:
        requests.post(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/refunds",
                      json={"amount": f"{missing_minor / 100:.2f}", "api_refund": False,
                            "reason": "Recorded a Stripe refund the webhook skipped for this method."},
                      auth=AUTH, timeout=30).raise_for_status()
    if fully:
        put_order(order_id, {"status": "refunded"})


def run():
    fixed = 0
    for order in paid_stripe_orders():
        if not is_stripe_apm(order["payment_method"]):
            continue
        order_total_minor = round(float(order["total"]) * 100)
        missing, fully = refund_action(order_total_minor, stripe_refunded_minor(order), wc_refunded_minor(order))
        if not missing and not (fully and order["status"] != "refunded"):
            continue
        log.info("Order %s: record %s, mark refunded=%s. %s",
                 order["id"], missing, fully, "dry run" if DRY_RUN else "applying")
        if not DRY_RUN:
            record_and_mark(order["id"], missing, fully and order["status"] != "refunded")
        fixed += 1
    log.info("Done. %d order(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
