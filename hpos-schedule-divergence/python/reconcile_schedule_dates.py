"""Reconcile WooCommerce Subscriptions schedule dates that have drifted between
HPOS (the authoritative wc_orders / wc_orders_meta tables) and the legacy postmeta
copy that some reports, exports, and older custom code still read directly.

When the two disagree, this trusts the HPOS value from the REST API as the
source of truth, then cross-checks it against Stripe: it reads the linked
renewal order's PaymentIntent (from order meta _stripe_intent_id, falling back
to transaction_id) and uses the charge time on that succeeded PaymentIntent to
confirm the next payment date is actually in the future relative to the last
real charge. Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_schedule_dates")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
# How much a schedule date is allowed to drift, in seconds, before we call it wrong.
DRIFT_TOLERANCE_SECONDS = int(os.environ.get("DRIFT_TOLERANCE_SECONDS", "3600"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_STATUSES = {"active", "pending-cancel"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def hpos_next_payment_ts(subscription):
    """The next payment date as WooCommerce (HPOS) reports it, epoch seconds or None."""
    return _parse_woo_datetime(subscription.get("schedule_next_payment"))


def meta_next_payment_ts(subscription):
    """The next payment date as it sits in legacy postmeta, epoch seconds or None."""
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_schedule_next_payment" and meta.get("value"):
            return _parse_woo_datetime(meta["value"])
    return None


def _parse_woo_datetime(value):
    import datetime

    if isinstance(value, dict):
        value = value.get("date")
    if not value:
        return None
    text = value.split(".")[0]
    try:
        dt = datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        dt = datetime.datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
    return int(dt.replace(tzinfo=datetime.timezone.utc).timestamp())


def decide(subscription, last_charge_ts):
    """Pure decision function. No I/O. Returns (action, reason).

    subscription is the WooCommerce Subscriptions REST resource (HPOS backed),
    with its meta_data array included so we can see the legacy postmeta copy.
    last_charge_ts is the Stripe PaymentIntent charge time (epoch seconds, or
    None) for the most recent renewal order tied to this subscription.

    Actions:
      skip      - subscription is not active, nothing to reconcile
      ok        - HPOS and postmeta agree, and the schedule is after the last charge
      diverged  - HPOS and postmeta disagree with each other, repair postmeta from HPOS
      stale     - HPOS agrees with postmeta but the next payment date is not after
                  the last real Stripe charge, flag for manual review
    """
    if subscription.get("status") not in ACTIVE_STATUSES:
        return ("skip", "subscription is not active")

    hpos_ts = hpos_next_payment_ts(subscription)
    if hpos_ts is None:
        return ("skip", "no HPOS schedule date to compare")

    meta_ts = meta_next_payment_ts(subscription)
    if meta_ts is not None and abs(hpos_ts - meta_ts) > DRIFT_TOLERANCE_SECONDS:
        return ("diverged", "HPOS schedule date and postmeta copy disagree")

    if last_charge_ts is not None and hpos_ts <= last_charge_ts:
        return ("stale", "next payment date is not after the last succeeded Stripe charge")

    return ("ok", "HPOS and postmeta agree, and the schedule is ahead of the last charge")


def get_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active,pending-cancel", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            yield sub
        page += 1


def get_last_renewal_order(subscription):
    """The most recent order in this subscription's order list, or None."""
    order_ids = subscription.get("_links", {}).get("order", [])
    # The REST resource also exposes related order ids on some setups; fall back
    # to the parent order when no renewal orders are linked yet.
    related = subscription.get("related_orders") or []
    order_id = (related[-1] if related else None) or subscription.get("parent_id")
    if not order_id:
        return None
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_last_charge_ts(order):
    """The Stripe charge time for a succeeded PaymentIntent on this order, or None."""
    if order is None:
        return None
    intent_id = intent_id_of(order)
    if not intent_id:
        return None
    try:
        intent = stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None
    if intent.get("status") != "succeeded":
        return None
    charge_id = intent.get("latest_charge")
    if charge_id:
        try:
            charge = stripe.Charge.retrieve(charge_id)
            return charge.get("created")
        except stripe.error.InvalidRequestError:
            pass
    return intent.get("created")


def repair_postmeta_from_hpos(subscription_id, hpos_ts):
    """Write the HPOS schedule date back onto the legacy postmeta key so anything
    still reading postmeta directly sees the same value the REST API reports.
    """
    import datetime

    iso = datetime.datetime.utcfromtimestamp(hpos_ts).strftime("%Y-%m-%dT%H:%M:%S")
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"meta_data": [{"key": "_schedule_next_payment", "value": iso}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": "Reconciled schedule date: postmeta was out of sync with HPOS. "
                      "The HPOS value was copied onto the legacy postmeta key."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def flag_for_review(subscription_id, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Schedule check failed: {reason}. HPOS and postmeta agree with "
                      f"each other but the date looks wrong against Stripe. Please review."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    reconciled = 0
    flagged = 0
    for subscription in get_subscriptions():
        last_order = get_last_renewal_order(subscription)
        last_charge_ts = get_last_charge_ts(last_order)
        action, reason = decide(subscription, last_charge_ts)

        if action in ("skip", "ok"):
            continue

        sub_id = subscription["id"]
        if action == "diverged":
            hpos_ts = hpos_next_payment_ts(subscription)
            log.info("Subscription %s: %s. %s", sub_id, reason,
                      "would repair" if DRY_RUN else "repairing")
            if not DRY_RUN:
                repair_postmeta_from_hpos(sub_id, hpos_ts)
            reconciled += 1
        elif action == "stale":
            log.warning("Subscription %s: %s. %s", sub_id, reason,
                        "would flag" if DRY_RUN else "flagging")
            if not DRY_RUN:
                flag_for_review(sub_id, reason)
            flagged += 1

    log.info(
        "Done. %d subscription(s) %s, %d flagged for review.",
        reconciled, "to repair" if DRY_RUN else "repaired", flagged,
    )


if __name__ == "__main__":
    run()
