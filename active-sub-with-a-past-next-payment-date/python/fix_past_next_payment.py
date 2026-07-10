"""Move an active WooCommerce subscription's next payment date forward when it has
fallen into the past.

A subscription's status and its billing schedule are stored separately. The status
can stay Active while the scheduled Action Scheduler event that should trigger the
renewal quietly fails to run (WP-Cron disabled, a backed up queue, a bad migration).
When that happens, next_payment never advances and eventually sits behind today.
This walks Active subscriptions, skips any with a renewal already in progress at
Stripe, and reschedules the rest forward using their own billing period and
interval. Dry run by default. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/active-sub-with-a-past-next-payment-date/
"""
import os
import logging
from datetime import datetime, timedelta, timezone
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_past_next_payment")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
GRACE_HOURS = int(os.environ.get("GRACE_HOURS", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PERIOD_DAYS = {"day": 1, "week": 7, "month": 30, "year": 365}
IN_PROGRESS_STATUSES = {"processing", "requires_action", "requires_capture"}


def active_subscriptions():
    """Page through every subscription with status active."""
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            yield sub
        page += 1


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in (order or {}).get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = (order or {}).get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def renewal_in_progress(last_order):
    """True when the subscription's last order has a Stripe PaymentIntent that is
    still mid-flight, so we should not race it by touching the schedule."""
    intent_id = intent_id_of(last_order)
    if not intent_id:
        return False
    try:
        intent = stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return False
    return intent.status in IN_PROGRESS_STATUSES


def advance(next_payment, period, interval, now):
    """Step next_payment forward by whole billing periods until it is in the future.

    Pure: no I/O, easy to unit test.
    """
    step = timedelta(days=PERIOD_DAYS[period] * interval)
    if step.total_seconds() <= 0:
        return next_payment
    while next_payment <= now:
        next_payment += step
    return next_payment


def decide(sub, now, renewal_in_progress=False):
    """Pure decision function: given a subscription view, the current time, and
    whether a renewal is already in progress, decide what to do.

    sub is expected to have: status, next_payment (aware datetime or None),
    billing_period, billing_interval.

    Returns a tuple of (action, reason, fixed_date) where action is one of
    "skip" or "reschedule".
    """
    if sub["status"] != "active":
        return ("skip", "subscription not active", None)
    if renewal_in_progress:
        return ("skip", "a renewal is already in progress", None)
    next_payment = sub["next_payment"]
    if next_payment is None or next_payment > now:
        return ("skip", "next payment date is not in the past", None)
    period = sub.get("billing_period", "month")
    interval = int(sub.get("billing_interval", 1) or 1)
    if period not in PERIOD_DAYS or interval < 1:
        return ("skip", "unknown billing schedule", None)
    fixed = advance(next_payment, period, interval, now)
    return ("reschedule", "next payment was in the past", fixed)


def reschedule(sub_id, fixed_date):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}",
        json={"next_payment_date_gmt": fixed_date.strftime("%Y-%m-%d %H:%M:%S")},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
        json={"note": f"Repaired by the schedule fixer. Next payment was in the past, "
                      f"moved forward to {fixed_date.isoformat()}."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def parse_wc_date(value):
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


def run():
    now = datetime.now(timezone.utc) - timedelta(hours=GRACE_HOURS)
    fixed_count = 0
    for sub in active_subscriptions():
        sub_view = {
            "status": sub["status"],
            "next_payment": parse_wc_date(sub.get("next_payment_date_gmt")),
            "billing_period": sub.get("billing_period"),
            "billing_interval": sub.get("billing_interval"),
        }
        in_progress = renewal_in_progress(sub.get("last_order"))
        action, reason, fixed_date = decide(sub_view, now, in_progress)
        if action != "reschedule":
            continue
        log.info(
            "Subscription %s: %s. New date %s. %s",
            sub["id"], reason, fixed_date.isoformat(),
            "would fix" if DRY_RUN else "fixing",
        )
        if not DRY_RUN:
            reschedule(sub["id"], fixed_date)
        fixed_count += 1
    log.info("Done. %d subscription(s) %s.", fixed_count, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
