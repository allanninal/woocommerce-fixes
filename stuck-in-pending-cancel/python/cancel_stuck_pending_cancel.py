"""Move WooCommerce Subscriptions out of pending-cancel when they are stuck there.

pending-cancel is meant to be a short holding status: the customer cancelled, but
WooCommerce Subscriptions lets the current paid period finish before the subscription
becomes cancelled. That flip is supposed to happen through an Action Scheduler hook
named woocommerce_scheduled_subscription_end_of_prepaid_term, scheduled for the
subscription's end date. When that scheduled action never runs (Action Scheduler
stalled, WP-Cron disabled, a migration that lost the scheduled action), the
subscription sits in pending-cancel forever: still billing-looking in reports, but
never actually cancelled.

This walks subscriptions with status pending-cancel, and for any whose end date has
passed, confirms with Stripe that the subscription is not still actively billing,
then moves it to cancelled through the WooCommerce REST API. Safe to run again and
again. Dry run by default.
"""
import os
import logging
from datetime import datetime, timezone

import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cancel_stuck_pending_cancel")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
GRACE_HOURS = int(os.environ.get("GRACE_HOURS", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Stripe subscription statuses that mean Stripe still considers the subscription live.
STRIPE_LIVE_STATUSES = {"active", "trialing", "past_due"}


def intent_id_of(order):
    """Kept for parity with the other fixes in this repo: the saved Stripe
    PaymentIntent id for an order, from meta _stripe_intent_id or transaction_id.
    Not used by the decision below, but handy if you extend this to cross-check
    the last renewal order too.
    """
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def stripe_sub_id_of(subscription):
    """The saved Stripe Subscription id, from meta _stripe_subscription_id, else None."""
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_subscription_id" and meta.get("value"):
            return meta["value"]
    return None


def parse_gmt(value):
    """Parse a WooCommerce *_gmt date string ("2026-07-01 00:00:00") to an aware
    UTC datetime. WooCommerce returns "0000-00-00 00:00:00" or an empty string
    when a date is not set, both of which mean "no end date"."""
    if not value or value.startswith("0000-00-00"):
        return None
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def decide(subscription, stripe_subscription, now):
    """Pure decision function. No I/O.

    subscription: a WooCommerce Subscriptions REST API subscription resource (dict).
    stripe_subscription: the matching Stripe Subscription object (dict-like) or None
        when the subscription has no Stripe id, or Stripe has no record of it.
    now: an aware UTC datetime, passed in so this is deterministic to test.

    Returns a tuple of (action, reason) where action is one of:
      "skip"    - not pending-cancel, nothing to do.
      "wait"    - pending-cancel but the end date has not arrived yet.
      "hold"    - end date has passed but Stripe still shows the subscription
                  actively billing, so cancelling in WooCommerce would be wrong.
      "cancel"  - end date has passed and Stripe agrees it is not live. Safe to
                  move the subscription to cancelled.
    """
    if subscription.get("status") != "pending-cancel":
        return ("skip", "subscription is not pending-cancel")

    end = parse_gmt(subscription.get("end_date_gmt") or subscription.get("end_gmt"))
    if end is None:
        return ("hold", "no end date set, cannot confirm the prepaid term is over")

    if now < end:
        return ("wait", "end date has not arrived yet")

    if stripe_sub_id_of(subscription) and stripe_subscription is not None:
        stripe_status = stripe_subscription.get("status")
        if stripe_status in STRIPE_LIVE_STATUSES:
            return ("hold", f"Stripe still shows the subscription as {stripe_status}")

    return ("cancel", "end date has passed and Stripe does not show it still billing")


def get_stripe_subscription(stripe_sub_id):
    if not stripe_sub_id:
        return None
    try:
        obj = stripe.Subscription.retrieve(stripe_sub_id)
        return dict(obj)
    except stripe.error.InvalidRequestError:
        return None


def pending_cancel_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "pending-cancel", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for subscription in batch:
            yield subscription
        page += 1


def cancel(subscription_id, reason):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"status": "cancelled"},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Moved from pending-cancel to cancelled by the reconciler. {reason}."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    now = datetime.now(timezone.utc)
    cancelled = 0
    for subscription in pending_cancel_subscriptions():
        stripe_sub_id = stripe_sub_id_of(subscription)
        stripe_subscription = get_stripe_subscription(stripe_sub_id)
        action, reason = decide(subscription, stripe_subscription, now)
        if action in ("skip", "wait"):
            continue
        if action == "hold":
            log.warning("Subscription %s left in pending-cancel: %s", subscription["id"], reason)
            continue
        log.info(
            "Subscription %s: %s. %s",
            subscription["id"], reason, "would cancel" if DRY_RUN else "cancelling",
        )
        if not DRY_RUN:
            cancel(subscription["id"], reason)
        cancelled += 1
    log.info("Done. %d subscription(s) %s.", cancelled, "to cancel" if DRY_RUN else "cancelled")


if __name__ == "__main__":
    run()
