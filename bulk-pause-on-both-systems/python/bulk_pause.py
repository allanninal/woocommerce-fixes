"""Pause a batch of WooCommerce subscriptions and their Stripe billing together.

Bulk changing a WooCommerce Subscription to on-hold only updates the store side:
the subscription status and its scheduled renewal actions. It does not touch
Stripe. When billing runs through a Stripe Subscription object (common with
WooPayments and Stripe integrations), Stripe keeps generating invoices on its own
schedule until something explicitly pauses it. This script walks a list of
subscription IDs, reads the matching Stripe subscription, and pauses both sides
together: WooCommerce to on-hold, Stripe with pause_collection (void). Skips
anything already paused, cancelled, or missing a Stripe subscription id. Safe by
default (dry run). Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/bulk-pause-on-both-systems/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bulk_pause")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
SUBSCRIPTION_IDS = [s.strip() for s in os.environ.get("SUBSCRIPTION_IDS", "").split(",") if s.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

WOO_ENDED_STATUSES = {"on-hold", "cancelled", "expired", "pending-cancel"}
STRIPE_ENDED_STATUSES = {"canceled", "incomplete_expired", "paused"}


def get_subscription(sub_id):
    """Read a WooCommerce Subscription by id. Returns None on 404."""
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def stripe_sub_id_of(subscription):
    """The saved Stripe Subscription id, from meta _stripe_subscription_id or transaction_id."""
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_subscription_id" and meta.get("value"):
            return meta["value"]
    tid = subscription.get("transaction_id")
    return tid if tid and tid.startswith("sub_") else None


def get_stripe_subscription(stripe_sub_id):
    """Read a Stripe Subscription by id. Returns None if missing or not found."""
    if not stripe_sub_id:
        return None
    try:
        return stripe.Subscription.retrieve(stripe_sub_id)
    except stripe.error.InvalidRequestError:
        return None


def decide(subscription, stripe_sub):
    """Pure decision: no I/O, only plain dict-like inputs and a plain tuple output.

    Returns (action, reason) where action is one of:
      "pause"  - active on both sides, safe to pause together
      "skip"   - already paused, cancelled, or otherwise not eligible
      "orphan" - no Stripe subscription id on file, needs a human to check
    """
    if subscription["status"] in WOO_ENDED_STATUSES:
        return ("skip", "WooCommerce subscription is not active")
    if stripe_sub is None:
        return ("orphan", "no Stripe subscription id on file")
    if stripe_sub["status"] in STRIPE_ENDED_STATUSES or stripe_sub.get("pause_collection"):
        return ("skip", "Stripe subscription already paused or ended")
    return ("pause", "active in WooCommerce and billing in Stripe")


def pause_both(subscription_id, stripe_sub_id):
    """Write side effect: pause WooCommerce and Stripe for one subscription."""
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"status": "on-hold"},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Bulk paused. Stripe subscription {stripe_sub_id} set to "
                      f"pause_collection (void) so it stops billing while on hold."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    stripe.Subscription.modify(stripe_sub_id, pause_collection={"behavior": "void"})


def run():
    paused = 0
    for sub_id in SUBSCRIPTION_IDS:
        subscription = get_subscription(sub_id)
        if subscription is None:
            log.warning("Subscription %s not found in WooCommerce", sub_id)
            continue
        stripe_sub_id = stripe_sub_id_of(subscription)
        stripe_sub = get_stripe_subscription(stripe_sub_id)
        action, reason = decide(subscription, stripe_sub)
        if action == "orphan":
            log.warning("Subscription %s: %s", sub_id, reason)
            continue
        if action == "skip":
            continue
        log.info("Subscription %s: %s. %s", sub_id, reason, "would pause" if DRY_RUN else "pausing")
        if not DRY_RUN:
            pause_both(sub_id, stripe_sub_id)
        paused += 1
    log.info("Done. %d subscription(s) %s.", paused, "to pause" if DRY_RUN else "paused")


if __name__ == "__main__":
    if not SUBSCRIPTION_IDS:
        log.warning("SUBSCRIPTION_IDS is empty. Set it to a comma separated list of subscription ids.")
    run()
