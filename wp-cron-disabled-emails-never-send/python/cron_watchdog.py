"""Detect a WooCommerce store where WP-Cron is disabled or starved, so order
emails and the Action Scheduler queue never fire. Read only by default.

This walks recent orders, checks each one's notes for evidence its
confirmation email went out, and raises a store-level alarm once enough
orders have waited past a safe threshold with no such note. It never
changes an order's status or total. When it does raise the alarm and
DRY_RUN is off, it leaves one diagnostic note on the oldest stuck order.

Run this from a real system cron, not from anything that depends on the
WordPress site's own WP-Cron, since that is the thing being checked.

Guide: https://www.allanninal.dev/woocommerce/wp-cron-disabled-emails-never-send/
"""
import os
import logging
import requests
from datetime import datetime, timedelta, timezone
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cron_watchdog")

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "6"))
STUCK_MINUTES = int(os.environ.get("STUCK_MINUTES", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EMAIL_NOTE_MARKERS = ("email sent", "order status changed", "note sent to customer")
MIN_STUCK_TO_ALARM = 3


def recent_orders(lookback_hours):
    """Orders created in the lookback window, oldest first."""
    since = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"after": since.isoformat(), "per_page": 100, "orderby": "date", "order": "asc"},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def order_notes(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes", auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id.

    Used only to cross-check a flagged order by hand: confirming the payment
    succeeded on Stripe rules out the payment side and points back at the
    email/scheduling side as the actual fault.
    """
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def has_email_note(notes):
    """True when an order note looks like the confirmation email went out."""
    for note in notes:
        text = (note.get("note") or "").lower()
        if note.get("customer_note") or any(m in text for m in EMAIL_NOTE_MARKERS):
            return True
    return False


def minutes_waiting(order, now):
    """Minutes between the order's creation time and now (both UTC)."""
    raw = order["date_created_gmt"]
    created = datetime.fromisoformat(raw if raw.endswith("+00:00") else raw + "+00:00")
    return (now - created).total_seconds() / 60


def decide(order, notes, now, stuck_minutes):
    """Pure decision: does this one order look stuck on its confirmation email?

    Returns a (action, reason) tuple. action is one of:
      "ok"    - a confirmation note already exists, nothing to worry about
      "wait"  - too soon to judge, still inside the grace window
      "stuck" - past the threshold with no confirming note
    """
    waited = minutes_waiting(order, now)
    if has_email_note(notes):
        return ("ok", "a confirmation note already exists")
    if waited < stuck_minutes:
        return ("wait", "too soon to judge, still inside the grace window")
    return ("stuck", f"no confirmation note after {int(waited)} minutes")


def store_verdict(stuck_count):
    """Pure decision: does the whole batch look like a WP-Cron outage?

    A single stuck order can be a fluke. A backlog is a signal.
    """
    if stuck_count >= MIN_STUCK_TO_ALARM:
        return ("alarm", f"{stuck_count} orders stuck, WP-Cron is likely disabled or starved")
    if stuck_count > 0:
        return ("watch", f"{stuck_count} order(s) stuck, below the alarm threshold")
    return ("healthy", "no stuck orders in this window")


def leave_diagnostic_note(order_id, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"WP-Cron watchdog: {reason}. WP-Cron appears disabled or starved on "
                      f"this store. Check DISABLE_WP_CRON in wp-config.php and whether a real "
                      f"system cron calls wp-cron.php."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    now = datetime.now(timezone.utc)
    stuck_orders = []
    for order in recent_orders(LOOKBACK_HOURS):
        notes = order_notes(order["id"])
        action, reason = decide(order, notes, now, STUCK_MINUTES)
        if action == "stuck":
            log.warning("Order %s: %s", order["id"], reason)
            stuck_orders.append((order, reason))
    verdict, message = store_verdict(len(stuck_orders))
    log.info("Verdict: %s. %s", verdict, message)
    if verdict == "alarm" and stuck_orders and not DRY_RUN:
        oldest_order, reason = stuck_orders[0]
        leave_diagnostic_note(oldest_order["id"], reason)
    log.info("Done. %s", "would flag" if DRY_RUN and verdict == "alarm" else "checked")


if __name__ == "__main__":
    run()
