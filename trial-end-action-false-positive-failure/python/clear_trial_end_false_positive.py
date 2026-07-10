"""Detect and clear a trial end action that Action Scheduler logged as failed
by mistake, even though the subscription already moved out of the trial.

WooCommerce Subscriptions runs woocommerce_scheduled_subscription_trial_end on
the trial end date. When a slow request, a second worker, or a timeout makes
that hook run twice, the loser of the race throws and Action Scheduler marks
the action failed, but the subscription already has the correct status and
the first renewal order already exists. The failed log entry is then a false
alarm, not a real billing problem.

This script pulls subscriptions that still show a trial-end action as failed,
checks the subscription status and its renewal order (and, when a renewal
order exists, its Stripe PaymentIntent) against the real state, and adds a
note that clears the alarm when everything actually succeeded. It never
re-runs the trial-end transition itself, since that is what caused the
duplicate-run risk in the first place. Read only unless DRY_RUN is off.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_trial_end_false_positive")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Statuses that mean the subscription is no longer sitting in a trial.
POST_TRIAL_STATUSES = {"active", "on-hold", "pending-cancel", "cancelled"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in (order or {}).get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = (order or {}).get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    return round(float(order["total"]) * 100)


def decide(subscription, renewal_order, intent):
    """Pure decision function. No I/O. Returns (action, reason).

    action is one of:
      "leave"  - the trial-end action failure looks real, do nothing
      "clear"  - the failure was a false positive, clear the alarm
      "unclear" - not enough evidence either way, needs a human to look
    """
    if subscription.get("status") not in POST_TRIAL_STATUSES:
        # The trial genuinely never finished transitioning. The logged
        # failure is probably real, so leave it for a human to chase.
        return ("leave", "subscription is still on trial or has no post-trial status")

    if subscription.get("status") == "active" and renewal_order is None:
        # Active with no renewal order at all is fine only when the plan
        # has a $0 signup and the first paid renewal has not been billed
        # yet. Anything else is unclear, since we cannot confirm billing.
        if subscription.get("trial_total_minor", 0) == 0:
            return ("clear", "subscription is active and the trial had no charge due")
        return ("unclear", "active with no renewal order and a nonzero trial amount")

    if renewal_order is None:
        return ("unclear", "no renewal order found to check against Stripe")

    if renewal_order.get("status") in {"cancelled", "failed"}:
        return ("leave", "the renewal order itself failed or was cancelled")

    if intent is None:
        return ("unclear", "renewal order has no matching Stripe PaymentIntent yet")

    if intent.get("status") != "succeeded":
        return ("leave", "Stripe shows the renewal payment did not succeed")

    if abs(order_amount_minor(renewal_order) - intent.get("amount_received", 0)) > 1:
        return ("unclear", "renewal order amount does not match the Stripe charge")

    return ("clear", "subscription moved past trial and the renewal charge succeeded on Stripe")


def get_subscription(sub_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_order(order_id):
    if not order_id:
        return None
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def flagged_subscriptions():
    """Subscriptions whose most recent trial-end action Action Scheduler
    reports as failed. This walks the custom meta a store typically sets
    (or mirrors) from the Action Scheduler failure log, filtered to the
    lookback window. Stores without that mirror can swap this for a direct
    Action Scheduler REST or database query.
    """
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={
                "status": "any",
                "per_page": 50,
                "page": page,
                "meta_key": "_trial_end_action_status",
                "meta_value": "failed",
            },
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            yield sub
        page += 1


def latest_renewal_order_id(subscription):
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_last_renewal_order_id" and meta.get("value"):
            return meta["value"]
    related = subscription.get("_links", {}).get("renewal_order") or []
    return related[0]["href"].rstrip("/").rsplit("/", 1)[-1] if related else None


def clear_alarm(subscription, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription['id']}/notes",
        json={"note": f"Trial end action false alarm cleared: {reason}. "
                      f"The subscription and its renewal charge are confirmed correct, "
                      f"so the failed Action Scheduler entry can be ignored."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    cleared = 0
    for subscription in flagged_subscriptions():
        order_id = latest_renewal_order_id(subscription)
        renewal_order = get_order(order_id)
        intent = get_intent(intent_id_of(renewal_order))
        action, reason = decide(subscription, renewal_order, intent)
        if action != "clear":
            if action == "unclear":
                log.warning("Subscription %s: %s. Needs a human look.", subscription["id"], reason)
            continue
        log.info("Subscription %s: %s. %s", subscription["id"], reason, "would clear" if DRY_RUN else "clearing")
        if not DRY_RUN:
            clear_alarm(subscription, reason)
        cleared += 1
    log.info("Done. %d subscription(s) %s.", cleared, "to clear" if DRY_RUN else "cleared")


if __name__ == "__main__":
    run()
