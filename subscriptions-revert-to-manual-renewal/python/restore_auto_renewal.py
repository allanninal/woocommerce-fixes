"""Restore WooCommerce subscriptions that wrongly flipped to manual renewal.

After a gateway change, an update, or a token migration, active subscriptions can be
switched to manual renewal even though they still hold a saved Stripe token. Manual
renewal means they stop charging on their own, so they silently lapse. This finds
active subscriptions that require manual renewal but still have a saved token, and
turns automatic renewal back on. Read only by default. Run on a schedule.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restore_auto_renewal")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

TOKEN_META_KEYS = ("_stripe_source_id", "_stripe_customer_id")


def has_saved_token(subscription):
    meta = {m.get("key"): m.get("value") for m in subscription.get("meta_data") or []}
    return any(meta.get(key) for key in TOKEN_META_KEYS)


def is_wrongly_manual(subscription):
    if subscription.get("status") != "active":
        return False
    if not subscription.get("requires_manual_renewal"):
        return False
    return has_saved_token(subscription)


def get(path, params=None):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3{path}", params=params or {}, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def restore_auto(subscription_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"requires_manual_renewal": False}, auth=AUTH, timeout=30,
    ).raise_for_status()


def subscriptions():
    page = 1
    while True:
        batch = get("/subscriptions", {"status": "active", "per_page": 50, "page": page})
        if not batch:
            return
        for subscription in batch:
            yield subscription
        page += 1


def run():
    fixed = 0
    for subscription in subscriptions():
        if not is_wrongly_manual(subscription):
            continue
        log.warning("Subscription %s is manual but has a saved token. %s",
                    subscription["id"], "would restore auto" if DRY_RUN else "restoring auto")
        if not DRY_RUN:
            restore_auto(subscription["id"])
        fixed += 1
    log.info("Done. %d subscription(s) %s.", fixed, "to restore" if DRY_RUN else "restored")


if __name__ == "__main__":
    run()
