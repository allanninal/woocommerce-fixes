"""Realign a WooCommerce Subscription's next payment date after an early renewal.

When a customer or store manager pays a renewal early ("Renew now" / pay it
forward), WooCommerce Subscriptions is supposed to push next_payment out to one
full billing period from that new paid date. A common bug in custom "renew
now" buttons and some REST driven manual renewals pays the order but never
calls the date update, so next_payment is left pointing at the old cadence.
The next charge then fires just days later instead of a full period out, and
every early renewal after that compounds the drift.

This reads recent renewal orders and their parent subscriptions from the
WooCommerce REST API, works out what next_payment should be from the last
paid renewal date plus the billing interval, and corrects the subscription's
schedule when it has drifted. It also cross checks the paid amount against
the Stripe PaymentIntent (read from order meta _stripe_intent_id, or
transaction_id) so we only trust a renewal that Stripe actually confirms.

Safe by default. Read only unless DRY_RUN is set to false. Run on a schedule.
"""
import os
import logging
from datetime import datetime, timedelta, timezone

import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("realign_next_payment")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "3"))
TOLERANCE_SECONDS = int(os.environ.get("TOLERANCE_SECONDS", "3600"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# One billing period in seconds, for the periods WooCommerce Subscriptions supports.
PERIOD_SECONDS = {
    "day": 86400,
    "week": 7 * 86400,
    "month": 30 * 86400,
    "year": 365 * 86400,
}

WC_DATE_FMT = "%Y-%m-%dT%H:%M:%S"


def parse_wc_date(value):
    """Parse a WooCommerce GMT date string into an aware UTC datetime, or None."""
    if not value:
        return None
    return datetime.strptime(value, WC_DATE_FMT).replace(tzinfo=timezone.utc)


def format_wc_date(dt):
    return dt.strftime(WC_DATE_FMT)


def meta_value(item, key):
    for meta in item.get("meta_data") or []:
        if meta.get("key") == key:
            return meta.get("value")
    return None


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    stored = meta_value(order, "_stripe_intent_id")
    if stored:
        return stored
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    """Order total in minor units (cents). Two decimal currencies only."""
    return round(float(order["total"]) * 100)


def expected_next_payment(last_paid_at, billing_interval, billing_period):
    """Pure. What next_payment should be: one full billing period after the
    renewal that was actually paid, regardless of when the old cadence
    said the charge was "due"."""
    seconds = PERIOD_SECONDS[billing_period] * billing_interval
    return last_paid_at + timedelta(seconds=seconds)


def decide(subscription, renewal_order, intent):
    """Pure decision function. No I/O. Returns (action, reason).

    Actions:
      skip  - nothing to do, schedule already correct or renewal not confirmed
      hold  - cannot safely decide, missing data
      fix   - next_payment has drifted from where the early renewal should
              place it, and it needs to move to the corrected date
    """
    if intent is None:
        return ("hold", "no Stripe PaymentIntent found for the renewal order")
    if intent.get("status") != "succeeded":
        return ("skip", "renewal payment not succeeded on Stripe")
    if abs(order_amount_minor(renewal_order) - intent.get("amount_received", 0)) > 1:
        return ("hold", "renewal amount does not match the Stripe charge")

    paid_at = parse_wc_date(renewal_order.get("date_paid_gmt") or renewal_order.get("date_created_gmt"))
    current_next_payment = parse_wc_date(meta_value(subscription, "_schedule_next_payment"))
    billing_interval = int(subscription.get("billing_interval") or 1)
    billing_period = subscription.get("billing_period")

    if paid_at is None or billing_period not in PERIOD_SECONDS:
        return ("hold", "missing paid date or unknown billing period")
    if current_next_payment is None:
        return ("hold", "subscription has no next payment date scheduled")

    correct_next_payment = expected_next_payment(paid_at, billing_interval, billing_period)
    drift = abs((current_next_payment - correct_next_payment).total_seconds())

    if drift <= TOLERANCE_SECONDS:
        return ("skip", "next payment date already matches the paid renewal")

    return ("fix", f"next payment is off by {int(drift)}s from the corrected cadence")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def recent_renewal_orders():
    """Renewal orders (parent_id > 0, meaning they belong to a subscription)
    created in the lookback window, paged through the REST API."""
    since = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).strftime(WC_DATE_FMT)
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"after": since, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            if meta_value(order, "_subscription_renewal"):
                yield order
        page += 1


def get_subscription(subscription_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def apply_fix(subscription_id, correct_next_payment):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"meta_data": [{"key": "_schedule_next_payment", "value": format_wc_date(correct_next_payment)}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": "Realigned the next payment date after an early renewal. "
                      f"New next payment: {format_wc_date(correct_next_payment)} UTC."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for renewal_order in recent_renewal_orders():
        subscription_id = meta_value(renewal_order, "_subscription_renewal")
        subscription = get_subscription(subscription_id)
        if subscription is None:
            log.warning("Renewal order %s points to missing subscription %s", renewal_order["id"], subscription_id)
            continue

        intent = get_intent(intent_id_of(renewal_order))
        action, reason = decide(subscription, renewal_order, intent)

        if action == "hold":
            log.warning("Subscription %s: %s", subscription_id, reason)
            continue
        if action == "skip":
            continue

        paid_at = parse_wc_date(renewal_order.get("date_paid_gmt") or renewal_order.get("date_created_gmt"))
        billing_interval = int(subscription.get("billing_interval") or 1)
        billing_period = subscription.get("billing_period")
        correct_next_payment = expected_next_payment(paid_at, billing_interval, billing_period)

        log.info("Subscription %s: %s. %s", subscription_id, reason, "would fix" if DRY_RUN else "fixing")
        if not DRY_RUN:
            apply_fix(subscription_id, correct_next_payment)
        fixed += 1

    log.info("Done. %d subscription(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
