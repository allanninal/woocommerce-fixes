"""Cancel a batch of WooCommerce subscriptions on both WooCommerce and Stripe.

Give it a list of WooCommerce subscription IDs. It reads the linked Stripe
subscription id from meta, checks the live status on both systems, and only
cancels the side that is not already cancelled. Subscriptions with no Stripe
id on file are reported as orphans instead of being skipped silently.
Safe to run again and again. Run with DRY_RUN=true first.

Guide: https://www.allanninal.dev/woocommerce/bulk-cancel-and-keep-in-sync/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bulk_cancel_sync")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
SUBSCRIPTION_IDS = [
    s.strip() for s in os.environ.get("SUBSCRIPTION_IDS", "").split(",") if s.strip()
]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

WOO_CANCELLED_STATUSES = {"cancelled"}
STRIPE_CANCELLED_STATUSES = {"canceled", "incomplete_expired"}


def stripe_sub_id_of(subscription):
    """The saved Stripe subscription id, from meta _stripe_subscription_id or transaction_id."""
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_subscription_id" and meta.get("value"):
            return meta["value"]
    tid = subscription.get("transaction_id")
    return tid if tid and tid.startswith("sub_") else None


def decide(woo_subscription, stripe_subscription):
    """Pure decision function: no I/O, only reads plain dicts.

    Returns a (action, reason) tuple. action is one of:
    "orphan", "skip", "cancel_both", "cancel_stripe_only", "cancel_woo_only".
    """
    if woo_subscription is None:
        return ("orphan", "woocommerce subscription not found")

    woo_status = woo_subscription["status"]
    woo_done = woo_status in WOO_CANCELLED_STATUSES

    if stripe_subscription is None:
        if woo_done:
            return ("orphan", "no Stripe subscription id on file, cannot confirm Stripe side")
        return ("orphan", "no Stripe subscription id on file, cancel Stripe by hand")

    stripe_done = stripe_subscription["status"] in STRIPE_CANCELLED_STATUSES

    if woo_done and stripe_done:
        return ("skip", "already cancelled on both sides")
    if not woo_done and not stripe_done:
        return ("cancel_both", "active on both sides")
    if not stripe_done:
        return ("cancel_stripe_only", "woo cancelled, stripe still active")
    return ("cancel_woo_only", "stripe cancelled, woo still active")


def get_woo_subscription(subscription_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{subscription_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_stripe_subscription(stripe_sub_id):
    if not stripe_sub_id:
        return None
    try:
        return stripe.Subscription.retrieve(stripe_sub_id)
    except stripe.error.InvalidRequestError:
        return None


def cancel_on_stripe(stripe_sub_id):
    stripe.Subscription.cancel(stripe_sub_id)


def cancel_on_woo(subscription_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{subscription_id}",
        json={"status": "cancelled"}, auth=AUTH, timeout=30,
    ).raise_for_status()


def add_note(subscription_id, text):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{subscription_id}/notes",
        json={"note": text}, auth=AUTH, timeout=30,
    ).raise_for_status()


def apply_action(action, subscription_id, stripe_sub_id):
    if action == "cancel_both":
        cancel_on_stripe(stripe_sub_id)
        cancel_on_woo(subscription_id)
        add_note(subscription_id, "Bulk cancel sync: cancelled on Stripe and WooCommerce.")
    elif action == "cancel_stripe_only":
        cancel_on_stripe(stripe_sub_id)
        add_note(subscription_id, "Bulk cancel sync: WooCommerce was already cancelled, "
                                   "Stripe subscription cancelled to match.")
    elif action == "cancel_woo_only":
        cancel_on_woo(subscription_id)
        add_note(subscription_id, "Bulk cancel sync: Stripe was already cancelled, "
                                   "WooCommerce status corrected to match.")


def run():
    fixed = 0
    orphans = 0
    for subscription_id in SUBSCRIPTION_IDS:
        woo_subscription = get_woo_subscription(subscription_id)
        stripe_sub_id = stripe_sub_id_of(woo_subscription) if woo_subscription else None
        stripe_subscription = get_stripe_subscription(stripe_sub_id)
        action, reason = decide(woo_subscription, stripe_subscription)

        if action == "orphan":
            log.warning("Subscription %s: orphan. %s", subscription_id, reason)
            orphans += 1
            continue
        if action == "skip":
            continue

        log.info("Subscription %s: %s. %s", subscription_id, reason,
                  "would fix" if DRY_RUN else "fixing")
        if not DRY_RUN:
            apply_action(action, subscription_id, stripe_sub_id)
        fixed += 1

    log.info("Done. %d subscription(s) %s, %d orphan(s) need manual review.",
              fixed, "to fix" if DRY_RUN else "fixed", orphans)


if __name__ == "__main__":
    run()
