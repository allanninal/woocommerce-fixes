"""Expire WooCommerce Subscriptions whose end date has already passed.

A subscription with a schedule "end_date" is supposed to stop billing and move to
Expired on its own, driven by an Action Scheduler hook. If that hook was deleted,
never queued, or missed its run while the site was down, the subscription just sits
on Active (or On hold) forever with an end date in the past. This walks subscriptions
with a set end_date, checks whether that date has passed, and moves any overdue one to
Expired through the REST API, the same way the scheduled hook would have. It also
confirms with Stripe that there is no unexpected still-active off-session mandate on
an already-overdue subscription, since a store deleting a stale mandate is safer than
leaving it live once the subscription should be gone. Read only by default. Run on a
schedule.
"""
import os
import logging
from datetime import datetime, timezone

import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("expire_overdue_subscriptions")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
GRACE_HOURS = int(os.environ.get("GRACE_HOURS", "6"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

OPEN_STATUSES = {"active", "on-hold", "pending-cancel"}
NO_END_DATE = "0000-00-00 00:00:00"


def parse_gmt(value):
    """Parse a WooCommerce *_date_gmt string into an aware UTC datetime, or None."""
    if not value or value == NO_END_DATE:
        return None
    text = value.replace("T", " ").replace("Z", "")
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def intent_id_of(subscription):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = subscription.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(subscription, now):
    """Pure decision: should this subscription be expired right now?

    subscription is a plain dict shaped like the WooCommerce Subscriptions REST API
    response (status, end_date_gmt, meta_data, transaction_id). now is an aware
    datetime, passed in so the function has no hidden clock and stays pure.
    """
    if subscription["status"] not in OPEN_STATUSES:
        return ("skip", "subscription is not in an open state")
    end_date = parse_gmt(subscription.get("end_date_gmt"))
    if end_date is None:
        return ("skip", "subscription has no end date, it renews until cancelled")
    if now < end_date:
        return ("skip", "end date has not arrived yet")
    overdue_hours = (now - end_date).total_seconds() / 3600
    if overdue_hours < GRACE_HOURS:
        return ("wait", "end date passed but still inside the grace window")
    return ("expire", f"end date passed {overdue_hours:.1f}h ago and is still open")


def get_subscription(subscription_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}", auth=AUTH, timeout=30
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def open_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active,on-hold,pending-cancel", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for subscription in batch:
            yield subscription
        page += 1


def cancel_stale_mandate(subscription):
    """Best-effort: cancel a Stripe PaymentIntent still sitting in a capturable state
    on a subscription we are about to expire. Never raises, since this is a courtesy
    cleanup and must not block the expiry itself.
    """
    intent_id = intent_id_of(subscription)
    if not intent_id:
        return
    try:
        intent = stripe.PaymentIntent.retrieve(intent_id)
        if intent.status in ("requires_capture", "requires_confirmation", "requires_action"):
            stripe.PaymentIntent.cancel(intent_id)
            log.info("Cancelled stale PaymentIntent %s on subscription %s", intent_id, subscription["id"])
    except stripe.error.StripeError as exc:
        log.warning("Could not check/cancel PaymentIntent %s: %s", intent_id, exc)


def mark_expired(subscription_id, reason):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"status": "expired"},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Expired by the scheduled check: {reason}. "
                      f"The end date had passed but the subscription was still open."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    now = datetime.now(timezone.utc)
    expired = 0
    for subscription in open_subscriptions():
        action, reason = decide(subscription, now)
        if action != "expire":
            continue
        log.info("Subscription %s: %s. %s", subscription["id"], reason,
                  "would expire" if DRY_RUN else "expiring")
        if not DRY_RUN:
            cancel_stale_mandate(subscription)
            mark_expired(subscription["id"], reason)
        expired += 1
    log.info("Done. %d subscription(s) %s.", expired, "to expire" if DRY_RUN else "expired")


if __name__ == "__main__":
    run()
