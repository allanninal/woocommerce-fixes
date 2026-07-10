"""Reactivate WooCommerce subscriptions that stayed On-Hold after a paid renewal.
Confirms payment first, so it only fixes subscriptions that were genuinely paid.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/subscription-on-hold-after-successful-renewal/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reactivate_paid_subs")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def should_reactivate(sub_status, latest_renewal_paid, stripe_active_and_paid):
    if sub_status != "on-hold":
        return False
    return bool(latest_renewal_paid or stripe_active_and_paid)


def on_hold_subscriptions():
    page = 1
    while True:
        r = requests.get(f"{WOO_URL}/wp-json/wc/v3/subscriptions",
                         params={"status": "on-hold", "per_page": 50, "page": page},
                         auth=AUTH, timeout=30)
        r.raise_for_status()
        subs = r.json()
        if not subs:
            return
        for sub in subs:
            yield sub
        page += 1


def get_order(order_id):
    if not order_id:
        return None
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def latest_renewal_paid(sub):
    order = get_order(sub.get("last_order_id") or sub.get("parent_id"))
    return bool(order) and order["status"] in PAID_STATUSES


def get_meta(sub, key):
    for m in sub.get("meta_data", []):
        if m.get("key") == key:
            return m.get("value")
    return None


def stripe_active_and_paid(sub):
    sub_id = get_meta(sub, "_wcpay_subscription_id") or get_meta(sub, "_stripe_subscription_id")
    if not sub_id or not stripe.api_key:
        return False
    s = stripe.Subscription.retrieve(sub_id, expand=["latest_invoice"])
    invoice = s.get("latest_invoice") or {}
    return s.get("status") in ("active", "trialing") and invoice.get("status") == "paid"


def reactivate(sub_id):
    requests.put(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}",
                 json={"status": "active"}, auth=AUTH, timeout=30).raise_for_status()
    requests.post(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
                  json={"note": "Renewal was paid but the subscription stayed on-hold. "
                                "Set back to active by the reconciler."},
                  auth=AUTH, timeout=30).raise_for_status()


def run():
    fixed = 0
    for sub in on_hold_subscriptions():
        paid_order = latest_renewal_paid(sub)
        paid_stripe = False if paid_order else stripe_active_and_paid(sub)
        if not should_reactivate(sub["status"], paid_order, paid_stripe):
            continue
        log.info("Subscription %s: paid but on-hold. %s", sub["id"], "would reactivate" if DRY_RUN else "reactivating")
        if not DRY_RUN:
            reactivate(sub["id"])
        fixed += 1
    log.info("Done. %d subscription(s) %s.", fixed, "to reactivate" if DRY_RUN else "reactivated")


if __name__ == "__main__":
    run()
