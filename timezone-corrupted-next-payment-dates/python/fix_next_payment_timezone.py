"""Detect and repair WooCommerce Subscriptions next payment dates that were saved in the
site's local time instead of UTC.

WooCommerce Subscriptions requires every schedule date (next_payment, next payment,
trial_end, end) to be stored in UTC. A local timezone plugin, a server timezone change,
or a hand edit through wp_postmeta or the orders table can save the site's local wall
clock time in that UTC field instead. The stored date then sits hours away from the
true UTC due date, which makes Action Scheduler fire the renewal early, fire it twice
in the same day if the store observes daylight saving, or miss the window and leave the
subscription looking overdue when it is not.

This script reads the subscription's saved schedule and billing period through the
WooCommerce REST API, works out what the next payment date should be from the last
paid renewal order and the billing interval, and compares that to the saved value in
whole hours. A clean offset that matches the site's UTC offset (or a small multiple of
it, which covers stacked timezone bugs) is corrected. Anything that does not line up
with a clean hour offset is left alone and reported, since guessing at those risks
making the subscription worse. Safe by default: DRY_RUN reports every change it would
make without writing anything.
"""
import os
import logging
from datetime import datetime, timedelta, timezone

import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_next_payment_timezone")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
SITE_UTC_OFFSET_HOURS = float(os.environ.get("SITE_UTC_OFFSET_HOURS", "0"))
MAX_OFFSET_MULTIPLE = int(os.environ.get("MAX_OFFSET_MULTIPLE", "2"))
TOLERANCE_MINUTES = int(os.environ.get("TOLERANCE_MINUTES", "5"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

BILLING_PERIOD_DAYS = {"day": 1, "week": 7, "month": 30, "year": 365}

WC_DATE_FMT = "%Y-%m-%dT%H:%M:%S"


def parse_woo_date(value):
    """Parse a WooCommerce date string (assumed UTC, no offset suffix) to an aware datetime."""
    if not value:
        return None
    return datetime.strptime(value, WC_DATE_FMT).replace(tzinfo=timezone.utc)


def expected_next_payment(last_paid_at, billing_interval, billing_period):
    """The next payment date a subscription should have, from its last paid renewal."""
    days = BILLING_PERIOD_DAYS.get(billing_period, 30) * max(billing_interval, 1)
    return last_paid_at + timedelta(days=days)


def hours_offset(expected, actual):
    """Signed whole hours between the expected UTC date and the actual saved UTC date."""
    delta = actual - expected
    return delta.total_seconds() / 3600.0


def decide(subscription, expected_next_payment_at, tolerance_minutes=TOLERANCE_MINUTES,
           site_utc_offset_hours=SITE_UTC_OFFSET_HOURS, max_offset_multiple=MAX_OFFSET_MULTIPLE):
    """Pure decision function. No I/O.

    subscription: dict with at least "id", "status", and "next_payment_date_gmt"
      (a WooCommerce date string, or None).
    expected_next_payment_at: an aware UTC datetime, the correct next payment date
      computed from the last paid renewal and the billing schedule.

    Returns (action, reason, corrected_iso_or_None):
      "skip"    - subscription is not active, or nothing to compare against.
      "ok"      - the saved date already matches within tolerance.
      "repair"  - the saved date is off by a clean multiple of the site's UTC offset;
                  corrected_iso holds the fixed UTC value to write back.
      "flag"    - the saved date is wrong but does not line up with a clean offset,
                  so it needs a human to look at it instead of an automatic repair.
    """
    if subscription.get("status") not in ("active", "on-hold"):
        return ("skip", "subscription is not active", None)

    saved = parse_woo_date(subscription.get("next_payment_date_gmt"))
    if saved is None:
        return ("skip", "no next payment date saved", None)

    if expected_next_payment_at is None:
        return ("skip", "no expected date to compare against", None)

    tolerance_hours = tolerance_minutes / 60.0
    offset = hours_offset(expected_next_payment_at, saved)

    if abs(offset) <= tolerance_hours:
        return ("ok", "matches the expected date", None)

    if site_utc_offset_hours:
        for multiple in range(1, max_offset_multiple + 1):
            step = site_utc_offset_hours * multiple
            if abs(abs(offset) - abs(step)) <= tolerance_hours:
                corrected = expected_next_payment_at.strftime(WC_DATE_FMT)
                return (
                    "repair",
                    f"off by {multiple}x the site UTC offset ({offset:+.1f}h), repairing to {corrected}",
                    corrected,
                )

    return ("flag", f"off by {offset:+.1f}h, does not match a clean site offset multiple", None)


def get_subscription(sub_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}", auth=AUTH, timeout=30
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_last_paid_renewal(sub_id):
    """The most recent renewal order for this subscription that is processing or completed."""
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"subscription": sub_id, "status": "processing,completed", "per_page": 1, "orderby": "date", "order": "desc"},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    batch = r.json()
    return batch[0] if batch else None


def active_subscriptions():
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


def repair_next_payment_date(sub_id, corrected_iso):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}",
        json={"next_payment_date_gmt": corrected_iso},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
        json={"note": f"Timezone repair: next payment date corrected to {corrected_iso} UTC. "
                      f"The saved date was off by a clean multiple of the site's UTC offset."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repaired = 0
    flagged = 0
    for sub in active_subscriptions():
        renewal = get_last_paid_renewal(sub["id"])
        if renewal is None:
            log.info("Subscription %s: no paid renewal yet, skipping", sub["id"])
            continue

        last_paid_at = parse_woo_date(renewal.get("date_paid_gmt") or renewal.get("date_created_gmt"))
        billing_interval = int(sub.get("billing_interval", 1) or 1)
        billing_period = sub.get("billing_period", "month")
        expected = expected_next_payment(last_paid_at, billing_interval, billing_period) if last_paid_at else None

        action, reason, corrected_iso = decide(sub, expected)

        if action in ("skip", "ok"):
            continue

        if action == "flag":
            log.warning("Subscription %s: %s", sub["id"], reason)
            flagged += 1
            continue

        log.info("Subscription %s: %s. %s", sub["id"], reason, "would repair" if DRY_RUN else "repairing")
        if not DRY_RUN:
            repair_next_payment_date(sub["id"], corrected_iso)
        repaired += 1

    log.info(
        "Done. %d subscription(s) %s, %d flagged for review.",
        repaired, "to repair" if DRY_RUN else "repaired", flagged,
    )


if __name__ == "__main__":
    run()
