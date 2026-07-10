"""Repoint WooCommerce subscriptions to the customer's current default Stripe card,
so renewals stop charging an old card the customer already replaced.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/new-card-not-linked-to-subscription/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repoint_sub_card")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def needs_repoint(stored_token, customer_default):
    if not customer_default:
        return False
    return stored_token != customer_default


def get_meta(sub, key):
    for m in sub.get("meta_data", []):
        if m.get("key") == key:
            return m.get("value")
    return None


def active_subscriptions():
    page = 1
    while True:
        r = requests.get(f"{WOO_URL}/wp-json/wc/v3/subscriptions",
                         params={"status": "active", "per_page": 50, "page": page},
                         auth=AUTH, timeout=30)
        r.raise_for_status()
        subs = r.json()
        if not subs:
            return
        for sub in subs:
            yield sub
        page += 1


def customer_default(customer_id):
    if not customer_id:
        return None
    customer = stripe.Customer.retrieve(customer_id)
    return (customer.get("invoice_settings") or {}).get("default_payment_method")


def repoint(sub_id, new_token):
    requests.put(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}",
                 json={"meta_data": [{"key": "_stripe_source_id", "value": new_token}]},
                 auth=AUTH, timeout=30).raise_for_status()
    requests.post(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
                  json={"note": f"Repointed the subscription to the current default card {new_token} "
                                f"so renewals stop charging the old one."},
                  auth=AUTH, timeout=30).raise_for_status()


def run():
    fixed = 0
    for sub in active_subscriptions():
        if not sub["payment_method"].startswith("stripe"):
            continue
        stored = get_meta(sub, "_stripe_source_id")
        default = customer_default(get_meta(sub, "_stripe_customer_id"))
        if not needs_repoint(stored, default):
            continue
        log.info("Subscription %s: %s -> %s. %s", sub["id"], stored, default, "dry run" if DRY_RUN else "repointing")
        if not DRY_RUN:
            repoint(sub["id"], default)
        fixed += 1
    log.info("Done. %d subscription(s) %s.", fixed, "to repoint" if DRY_RUN else "repointed")


if __name__ == "__main__":
    run()
