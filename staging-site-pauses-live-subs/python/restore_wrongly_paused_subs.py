"""Restore live WooCommerce subscriptions that a staging site wrongly paused.

A staging copy of the store (built with a migration or backup plugin) can end up
pointed at the live WooCommerce REST API and the live Stripe account, usually
because the site URL was swapped but a saved API key or webhook target was not.
When staging's own cron runs subscription renewals, a mismatched key or a stale
test card makes the "payment" fail on staging, and WooCommerce Subscriptions
calls payment_failed() on the real, live subscription. The customer was never
actually charged for anything on staging, but their live subscription is now
On-Hold and billing has stopped.

This script finds subscriptions that were paused by a run that did not come from
the live site, confirms with Stripe that the most recent invoice for that
subscription is genuinely paid, and restores only those to Active. Safe to run
again and again. Read only until DRY_RUN is turned off.

Guide: https://www.allanninal.dev/woocommerce/staging-site-pauses-live-subs/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restore_wrongly_paused_subs")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LIVE_SITE_HOST = os.environ.get("LIVE_SITE_HOST", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Statuses that count as "billing is active" once we restore.
RESTORABLE_FROM = {"on-hold"}


def get_meta(obj, key):
    """Read a value out of a WooCommerce meta_data list by key."""
    for m in obj.get("meta_data", []) or []:
        if m.get("key") == key:
            return m.get("value")
    return None


def paused_by_host(sub):
    """The hostname that last paused this subscription, if the pause recorded one.

    The staging clone writes its own hostname into `_paused_by_host` meta when it
    changes a subscription's status, the same way it would tag any other write.
    A missing value means we cannot tell where the pause came from, so we treat
    that as "unknown" rather than assume it is safe to touch.
    """
    return get_meta(sub, "_paused_by_host")


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(sub, latest_invoice, live_site_host):
    """Pure decision: should this subscription be restored to active?

    sub is a WooCommerce subscription resource (dict). latest_invoice is the
    Stripe invoice for the subscription's current billing period, or None if it
    could not be found or Stripe has no record of one. live_site_host is the
    production hostname, used to tell a staging-originated pause apart from a
    real one. Returns (action, reason) and never performs any I/O.
    """
    if sub.get("status") not in RESTORABLE_FROM:
        return ("skip", "subscription is not on-hold")

    host = paused_by_host(sub)
    if not host:
        return ("skip", "no record of what paused it, leave it for manual review")
    if host == live_site_host:
        return ("skip", "paused by the live site, likely a real failed payment")

    if latest_invoice is None:
        return ("hold", "paused by a non-live host but Stripe has no matching invoice")
    if latest_invoice.get("status") != "paid":
        return ("hold", "paused by a non-live host and Stripe invoice is not paid either")

    return ("restore", "paused by a non-live host, but Stripe shows the invoice paid")


def on_hold_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "on-hold", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        subs = r.json()
        if not subs:
            return
        for sub in subs:
            yield sub
        page += 1


def get_latest_invoice(sub):
    sub_id = get_meta(sub, "_stripe_subscription_id") or get_meta(sub, "_wcpay_subscription_id")
    if not sub_id or not stripe.api_key:
        return None
    try:
        stripe_sub = stripe.Subscription.retrieve(sub_id, expand=["latest_invoice"])
    except stripe.error.InvalidRequestError:
        return None
    return stripe_sub.get("latest_invoice")


def restore(sub_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}",
        json={"status": "active"}, auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
        json={"note": "This subscription was paused by a non-live host (likely a staging "
                      "copy that shared the live API and Stripe keys). Stripe confirms the "
                      "latest invoice is paid, so it was restored to Active by the reconciler."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    restored = 0
    held = 0
    for sub in on_hold_subscriptions():
        invoice = get_latest_invoice(sub)
        action, reason = decide(sub, invoice, LIVE_SITE_HOST)
        if action == "skip":
            continue
        if action == "hold":
            log.warning("Subscription %s: %s. Left on-hold for manual review.", sub["id"], reason)
            held += 1
            continue
        log.info("Subscription %s: %s. %s", sub["id"], reason, "would restore" if DRY_RUN else "restoring")
        if not DRY_RUN:
            restore(sub["id"])
        restored += 1
    log.info("Done. %d subscription(s) %s, %d held for review.",
              restored, "to restore" if DRY_RUN else "restored", held)


if __name__ == "__main__":
    run()
