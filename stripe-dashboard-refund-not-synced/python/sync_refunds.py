"""Record Stripe dashboard refunds that never synced to WooCommerce.
Uses api_refund false, so it never refunds the customer twice.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/stripe-dashboard-refund-not-synced/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync_refunds")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "72"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def recent_refunded_charges(lookback_hours):
    since = int(time.time()) - lookback_hours * 3600
    seen = set()
    for refund in stripe.Refund.list(limit=100, created={"gte": since}).auto_paging_iter():
        charge_id = refund.get("charge")
        if not charge_id or charge_id in seen:
            continue
        seen.add(charge_id)
        charge = stripe.Charge.retrieve(charge_id)
        order_id = (charge.get("metadata") or {}).get("order_id")
        if order_id:
            yield order_id, charge


def wc_refunds(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/refunds", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def wc_refunded_minor(refunds):
    return sum(round(abs(float(r["amount"])) * 100) for r in refunds)


def missing_refund_minor(stripe_refunded_minor, refunds):
    gap = stripe_refunded_minor - wc_refunded_minor(refunds)
    return gap if gap > 1 else 0


def record_refund(order_id, amount_minor):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/refunds",
        json={
            "amount": f"{amount_minor / 100:.2f}",
            "reason": "Recorded from a Stripe dashboard refund. No money moved on Stripe.",
            "api_refund": False,
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    recorded = 0
    for order_id, charge in recent_refunded_charges(LOOKBACK_HOURS):
        refunds = wc_refunds(order_id)
        if refunds is None:
            log.warning("Charge for order %s but the order is missing in Woo", order_id)
            continue
        missing = missing_refund_minor(charge["amount_refunded"], refunds)
        if not missing:
            continue
        log.info("Order %s: Stripe refunded %s more than Woo has. %s",
                 order_id, missing, "would record" if DRY_RUN else "recording")
        if not DRY_RUN:
            record_refund(order_id, missing)
        recorded += 1
    log.info("Done. %d refund(s) %s.", recorded, "to record" if DRY_RUN else "recorded")


if __name__ == "__main__":
    run()
