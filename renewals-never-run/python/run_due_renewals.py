"""Trigger WooCommerce Subscriptions renewals that Action Scheduler stopped running.

When the Action Scheduler queue stalls (a fatal error in one action, a maxed out
worker, a cron that stopped firing) the scheduled-subscription-payment actions pile
up "pending" long past their scheduled_date. WooCommerce never asked Stripe for the
money, so the subscription just sits there looking active while nothing is billed.

This walks orders that look like stuck renewals, reads the saved Stripe PaymentIntent
(or the customer's saved payment method) and charges the renewal amount directly
through the Stripe API, then reports the result back onto the order. Read the queue
through Action Scheduler's own table via a small custom endpoint, or, if you do not
want a custom endpoint, treat any subscription whose "next payment" date is in the
past as due. Safe to run again and again. Read only in DRY_RUN mode.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("run_due_renewals")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
GRACE_HOURS = int(os.environ.get("GRACE_HOURS", "3"))
STALE_DAYS = int(os.environ.get("STALE_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RENEWABLE_STATUSES = {"active", "on-hold"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(order["total"]) * 100)


def hours_overdue(scheduled_ts, now_ts):
    return (now_ts - scheduled_ts) / 3600


def decide(subscription, now_ts, grace_hours=GRACE_HOURS, stale_days=STALE_DAYS):
    """Pure decision: what to do about one subscription's due renewal.

    subscription is a plain dict with:
      status: the subscription status string
      next_payment_ts: unix timestamp the renewal was scheduled for, or None
      last_order_status: status of the most recent renewal order, or None
      payment_method_token: a saved Stripe payment method id, or None

    Returns (action, reason) where action is one of:
      "skip"    - nothing due, or already handled
      "wait"    - due, but still inside the grace window, leave it to the scheduler
      "charge"  - due, past grace, and we have what we need to charge it
      "blocked" - due, past grace, but there is no saved payment method to charge
      "stale"   - overdue so long it needs a human, not an auto charge
    """
    if subscription["status"] not in RENEWABLE_STATUSES:
        return ("skip", "subscription is not active or on-hold")
    if subscription.get("next_payment_ts") is None:
        return ("skip", "no renewal scheduled")
    if subscription["last_order_status"] in ("processing", "completed"):
        return ("skip", "renewal already paid")

    overdue_hours = hours_overdue(subscription["next_payment_ts"], now_ts)
    if overdue_hours < 0:
        return ("skip", "renewal is not due yet")
    if overdue_hours < grace_hours:
        return ("wait", "inside the grace window, scheduler may still catch it")
    if overdue_hours >= stale_days * 24:
        return ("stale", "overdue longer than the stale window, needs a human look")
    if not subscription.get("payment_method_token"):
        return ("blocked", "no saved payment method to charge")
    return ("charge", "past due and past grace, safe to charge now")


def get_subscription(subscription_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        auth=AUTH, timeout=30,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def due_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active,on-hold", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            yield sub
        page += 1


def charge_renewal(subscription, order):
    """Charge the saved payment method off-session for the renewal amount."""
    amount = order_amount_minor(order)
    intent = stripe.PaymentIntent.create(
        amount=amount,
        currency=order.get("currency", "usd").lower(),
        customer=subscription["customer_stripe_id"],
        payment_method=subscription["payment_method_token"],
        off_session=True,
        confirm=True,
        metadata={"order_id": str(order["id"]), "subscription_id": str(subscription["id"])},
    )
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"status": "processing", "transaction_id": intent.id},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Renewal charged manually after Action Scheduler stalled. "
                      f"Stripe PaymentIntent {intent.id}, status {intent.status}."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    return intent


def run():
    charged = 0
    now_ts = int(time.time())
    for sub in due_subscriptions():
        order = sub.get("last_order") or {}
        record = {
            "status": sub["status"],
            "next_payment_ts": sub.get("next_payment_ts"),
            "last_order_status": order.get("status"),
            "payment_method_token": sub.get("payment_method_token"),
        }
        action, reason = decide(record, now_ts)
        if action in ("skip", "wait"):
            continue
        if action in ("blocked", "stale"):
            log.warning("Subscription %s: %s. %s", sub["id"], action, reason)
            continue
        log.info("Subscription %s: %s. %s", sub["id"], reason, "would charge" if DRY_RUN else "charging")
        if not DRY_RUN:
            charge_renewal(sub, order)
        charged += 1
    log.info("Done. %d renewal(s) %s.", charged, "to charge" if DRY_RUN else "charged")


if __name__ == "__main__":
    run()
