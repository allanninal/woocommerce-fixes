"""Recover the Stripe card for WooCommerce subscriptions that lost it,
so automatic renewals can run again.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/subscription-missing-saved-card-token/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_sub_token")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def get_meta(record, key):
    for m in record.get("meta_data", []):
        if m.get("key") == key:
            return m.get("value")
    return None


def needs_token_backfill(sub):
    if not sub["payment_method"].startswith("stripe"):
        return False
    if sub["status"] not in ("active", "on-hold"):
        return False
    return not get_meta(sub, "_stripe_customer_id")


def subscriptions():
    page = 1
    while True:
        r = requests.get(f"{WOO_URL}/wp-json/wc/v3/subscriptions",
                         params={"status": "active,on-hold", "per_page": 50, "page": page},
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


def recover_card(sub):
    parent = get_order(sub.get("parent_id"))
    if not parent or parent["status"] not in PAID_STATUSES:
        return None
    intent_id = get_meta(parent, "_stripe_intent_id")
    if not intent_id:
        return None
    intent = stripe.PaymentIntent.retrieve(intent_id)
    customer, method = intent.get("customer"), intent.get("payment_method")
    if customer and method:
        return {"customer": customer, "method": method}
    return None


def backfill_sub(sub_id, card):
    requests.put(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}",
                 json={"meta_data": [
                     {"key": "_stripe_customer_id", "value": card["customer"]},
                     {"key": "_stripe_source_id", "value": card["method"]},
                 ]}, auth=AUTH, timeout=30).raise_for_status()
    requests.post(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
                  json={"note": f"Recovered the Stripe card ({card['method']}) from the first paid order "
                                f"and put it back on the subscription so renewals can run."},
                  auth=AUTH, timeout=30).raise_for_status()


def run():
    fixed = flagged = 0
    for sub in subscriptions():
        if not needs_token_backfill(sub):
            continue
        card = recover_card(sub)
        if not card:
            log.warning("Subscription %s has no reusable card on Stripe. Flag for a customer update.", sub["id"])
            flagged += 1
            continue
        log.info("Subscription %s: recovered %s. %s", sub["id"], card["method"], "would backfill" if DRY_RUN else "backfilling")
        if not DRY_RUN:
            backfill_sub(sub["id"], card)
        fixed += 1
    log.info("Done. %d backfilled, %d flagged %s.", fixed, flagged, "(dry run)" if DRY_RUN else "")


if __name__ == "__main__":
    run()
