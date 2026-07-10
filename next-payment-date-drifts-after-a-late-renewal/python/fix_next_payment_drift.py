"""Correct a WooCommerce Subscriptions next payment date that drifted after a late renewal.

When a renewal runs late, from a failed payment retry, a delayed Action Scheduler
run, or a manual retry from wp-admin, some paths recompute the next payment date
from the moment the late renewal completed instead of from the subscription's
original billing schedule. Each late renewal after that nudges the date a little
further off. This walks active subscriptions, recomputes the correct next payment
date from the billing interval and period anchored to the start date, and corrects
the stored date whenever it disagrees by more than a small tolerance, adding a
subscription note either way. Safe to run again and again. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/next-payment-date-drifts-after-a-late-renewal/
"""
import os
import logging
from datetime import datetime, timedelta, timezone
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_next_payment_drift")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRIFT_TOLERANCE_HOURS = float(os.environ.get("DRIFT_TOLERANCE_HOURS", "6"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def _days_in_month(year, month):
    if month == 12:
        return 31
    next_month_first = datetime(year, month + 1, 1)
    return (next_month_first - timedelta(days=1)).day


def add_interval(dt, period, interval):
    """Step a datetime forward by one or more whole billing periods."""
    if period == "day":
        return dt + timedelta(days=interval)
    if period == "week":
        return dt + timedelta(weeks=interval)
    if period in ("month", "year"):
        months_to_add = interval * (12 if period == "year" else 1)
        month_index = dt.month - 1 + months_to_add
        year = dt.year + month_index // 12
        month = month_index % 12 + 1
        day = min(dt.day, _days_in_month(year, month))
        return dt.replace(year=year, month=month, day=day)
    raise ValueError(f"unknown billing period: {period}")


def correct_next_payment(start_date, period, interval, now):
    """Pure: step forward in whole billing intervals from start_date until the
    result is strictly after now. No I/O, so this is fully unit testable."""
    if interval <= 0:
        raise ValueError("interval must be positive")
    next_date = add_interval(start_date, period, interval)
    guard = 0
    while next_date <= now:
        next_date = add_interval(next_date, period, interval)
        guard += 1
        if guard > 10000:
            raise RuntimeError("schedule did not converge, check inputs")
    return next_date


def decide(subscription, now, tolerance_hours=DRIFT_TOLERANCE_HOURS):
    """Pure decision: given a subscription and the current time, decide whether its
    stored next payment date has drifted from the true schedule. No I/O here, so
    this is fully unit testable."""
    if subscription.get("status") != "active":
        return ("skip", "subscription not active")
    start = subscription["start_date_gmt"]
    period = subscription["billing_period"]
    interval = int(subscription["billing_interval"])
    stored = subscription.get("next_payment_date_gmt")
    if not stored:
        return ("skip", "no next payment date stored yet")
    correct = correct_next_payment(start, period, interval, now)
    drift_hours = (stored - correct).total_seconds() / 3600
    if abs(drift_hours) <= tolerance_hours:
        return ("ok", "next payment date matches the schedule")
    direction = "ahead of" if drift_hours > 0 else "behind"
    return ("fix", f"stored date is {abs(drift_hours):.1f}h {direction} schedule")


def active_subscriptions():
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


def parse_gmt(value):
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


def correct_schedule(subscription_id, correct_date, reason):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"next_payment_date_gmt": correct_date.strftime("%Y-%m-%dT%H:%M:%S")},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Next payment date corrected: {reason}. Recomputed from the "
                      f"billing schedule and reset to {correct_date.isoformat()}."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    now = datetime.now(timezone.utc)
    for subscription in active_subscriptions():
        parsed = dict(subscription)
        parsed["start_date_gmt"] = parse_gmt(subscription.get("start_date_gmt"))
        parsed["next_payment_date_gmt"] = parse_gmt(subscription.get("next_payment_date_gmt"))
        action, reason = decide(parsed, now)
        if action != "fix":
            continue
        correct_date = correct_next_payment(
            parsed["start_date_gmt"], parsed["billing_period"], int(parsed["billing_interval"]), now
        )
        log.warning(
            "Subscription %s: %s. %s",
            subscription["id"], reason, "would fix" if DRY_RUN else "fixing",
        )
        if not DRY_RUN:
            correct_schedule(subscription["id"], correct_date, reason)
        fixed += 1
    log.info("Done. %d subscription(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
