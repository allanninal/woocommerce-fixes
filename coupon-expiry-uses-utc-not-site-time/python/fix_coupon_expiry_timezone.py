"""Detect and repair WooCommerce coupons that expire on the wrong local day
because date_expires is stored and compared in UTC, not site time.

WooCommerce saves a coupon's expiry as a UTC timestamp (date_expires_gmt) and
compares it against the current UTC time to decide whether the coupon is
still valid. The shop owner picks a date in the WordPress admin thinking in
site time (the store's local timezone). For any store west of UTC, midnight
UTC on the chosen date lands several hours BEFORE local midnight, so the
coupon dies on what the calendar still shows as the intended day. For stores
east of UTC, the coupon can outlive its intended day instead.

This script asks the WooCommerce REST API for coupons with an expiry date,
works out the coupon's actual last valid moment in the store's local
timezone, and flags any coupon whose local expiry moment does not land at
the end of the calendar day the code implies (23:59:59 local). When it
finds one, it can rewrite date_expires_gmt so the coupon actually expires at
the end of the intended local day. Dry run by default. Safe to run again
and again, because a coupon that already expires at end of local day is
left alone.
"""
import os
import logging
from datetime import datetime, timedelta, timezone

import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_coupon_expiry_timezone")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])

# Store's UTC offset in minutes, e.g. -300 for America/New_York (EST), 480 for
# Asia/Manila. WordPress exposes this as gmt_offset (hours) under
# Settings, General. Multiply by 60 if you copy that value in.
SITE_UTC_OFFSET_MINUTES = int(os.environ.get("SITE_UTC_OFFSET_MINUTES", "0"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def to_local(dt_utc, offset_minutes):
    """Convert a naive UTC datetime to a naive local datetime using a fixed
    minute offset. WooCommerce dates are naive (no tzinfo), so we keep this
    naive too and treat the offset as a simple, constant shift.
    """
    return dt_utc + timedelta(minutes=offset_minutes)


def end_of_local_day_in_utc(local_dt, offset_minutes):
    """Given a naive local datetime, return the UTC instant that corresponds
    to 23:59:59 local time on that same local calendar date.
    """
    end_of_day_local = local_dt.replace(hour=23, minute=59, second=59, microsecond=0)
    return end_of_day_local - timedelta(minutes=offset_minutes)


def parse_woo_datetime(value):
    """Parse a WooCommerce ISO-ish datetime string ("2026-07-10T00:00:00")
    into a naive UTC datetime. Returns None for empty or missing values.
    """
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", ""))


def decide(coupon, site_utc_offset_minutes):
    """Pure decision: does this coupon's UTC expiry land on the wrong local
    day (or the right day but not at the end of it), and if so what should
    the corrected date_expires_gmt be.

    coupon: a dict with "id", "code", and "date_expires_gmt" (a
      WooCommerce-style ISO datetime string, or "" / None when the coupon
      never expires).
    site_utc_offset_minutes: the store's fixed UTC offset in minutes.

    The admin picks a calendar date, e.g. 2026-07-10, and WooCommerce stores
    that same date at 00:00:00 as date_expires_gmt, treating it as UTC. The
    "intended" local calendar date is the date portion of that raw string.
    We check whether the stored UTC instant, once converted to site time,
    still falls on that same intended date, and whether it lands at the end
    of that day (23:59:59 local) rather than somewhere in the middle of it.

    Returns a tuple of (action, reason, corrected_gmt_iso_or_None):
      "skip"    no expiry set, nothing to check
      "ok"      the expiry already lands at end of the intended local day
      "correct" the expiry is off by more than a minute; corrected_gmt_iso
                holds the ISO string to write back to date_expires_gmt
    """
    expires_gmt = coupon.get("date_expires_gmt")
    if not expires_gmt:
        return ("skip", "coupon has no expiry date", None)

    expires_utc = parse_woo_datetime(expires_gmt)
    intended_date = expires_utc.date()

    local_expires = to_local(expires_utc, site_utc_offset_minutes)
    intended_utc = end_of_local_day_in_utc(local_expires, site_utc_offset_minutes)

    drift_seconds = abs((intended_utc - expires_utc).total_seconds())
    if drift_seconds <= 60:
        return ("ok", "expiry already lands at end of the local day", None)

    if local_expires.date() != intended_date:
        reason = "expiry crosses UTC midnight onto the wrong local calendar day"
    else:
        reason = "expiry is mid-day in site time, coupon dies hours early"
    return ("correct", reason, intended_utc.isoformat())


def list_expiring_coupons():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/coupons",
            params={"per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for coupon in batch:
            if coupon.get("date_expires_gmt"):
                yield coupon
        page += 1


def apply_fix(coupon_id, corrected_gmt_iso):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/coupons/{coupon_id}",
        json={"date_expires_gmt": corrected_gmt_iso},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for coupon in list_expiring_coupons():
        action, reason, corrected_gmt_iso = decide(coupon, SITE_UTC_OFFSET_MINUTES)
        if action != "correct":
            continue
        log.info(
            "Coupon %s (%s): %s. %s",
            coupon["id"], coupon.get("code"), reason,
            "would correct" if DRY_RUN else "correcting",
        )
        if not DRY_RUN:
            apply_fix(coupon["id"], corrected_gmt_iso)
        fixed += 1
    log.info("Done. %d coupon(s) %s.", fixed, "to correct" if DRY_RUN else "corrected")


if __name__ == "__main__":
    run()
