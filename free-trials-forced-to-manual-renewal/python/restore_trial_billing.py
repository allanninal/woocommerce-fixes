"""Restore automatic billing for free trial subscriptions that were forced to
manual renewal because the card save was never confirmed.

A free trial checkout confirms a zero amount Stripe setup that is only supposed
to save a reusable card for later, no money moves yet. If that confirmation is
interrupted (closed tab, abandoned 3D Secure, a missing script on the thank you
page), the trial still completes but no payment method is ever saved. When the
trial ends, WooCommerce Subscriptions correctly has nothing to charge and marks
the subscription "requires manual renewal" instead of failing silently.

This job walks subscriptions currently on manual renewal, checks whether Stripe
now has a real, reusable, non-expired payment method for that customer, and
switches eligible subscriptions back to automatic. Safe by default (dry run).
Run on a schedule, once a day is plenty.

Guide: https://www.allanninal.dev/woocommerce/free-trials-forced-to-manual-renewal/
"""
import os
import logging
from datetime import date

import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restore_trial_billing")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def manual_renewal_subscriptions():
    """Yield every WooCommerce subscription currently flagged manual renewal."""
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active,pending", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            if sub.get("requires_manual_renewal"):
                yield sub
        page += 1


def stripe_customer_id(subscription):
    """The Stripe customer id saved on the subscription, if any."""
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_customer_id" and meta.get("value"):
            return meta["value"]
    return None


def usable_payment_method(customer_id):
    """The first reusable, non-expired card Stripe has on file for this customer."""
    if not customer_id:
        return None
    methods = stripe.PaymentMethod.list(customer=customer_id, type="card")
    today = date.today()
    for pm in methods.auto_paging_iter():
        card = pm.card
        if card and not (card.exp_year, card.exp_month) < (today.year, today.month):
            return pm
    return None


def decide(subscription, payment_method):
    """Pure decision: does this subscription get switched back to automatic?

    subscription: dict with at least "requires_manual_renewal".
    payment_method: a Stripe PaymentMethod-like object (needs .id), or None.
    Returns a (action, reason) tuple. action is one of "restore" or "skip".
    No I/O happens here, so this can be unit tested without a network.
    """
    if not subscription.get("requires_manual_renewal"):
        return ("skip", "subscription is already automatic")
    if payment_method is None:
        return ("skip", "no reusable payment method on file yet")
    return ("restore", "Stripe has a usable card, safe to restore automatic billing")


def restore_automatic(subscription_id, payment_method):
    """Flip requires_manual_renewal off and save the payment method as the token."""
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={
            "requires_manual_renewal": False,
            "meta_data": [{"key": "_stripe_source_id", "value": payment_method.id}],
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Restored automatic renewal. Found reusable payment method "
                      f"{payment_method.id} on the Stripe customer. Set by the repair job."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    restored = 0
    for sub in manual_renewal_subscriptions():
        customer_id = stripe_customer_id(sub)
        pm = usable_payment_method(customer_id)
        action, reason = decide(sub, pm)
        if action == "skip":
            log.info("Subscription %s: %s", sub["id"], reason)
            continue
        log.info("Subscription %s: %s. %s", sub["id"], reason, "would restore" if DRY_RUN else "restoring")
        if not DRY_RUN:
            restore_automatic(sub["id"], pm)
        restored += 1
    log.info("Done. %d subscription(s) %s.", restored, "to restore" if DRY_RUN else "restored")


if __name__ == "__main__":
    run()
