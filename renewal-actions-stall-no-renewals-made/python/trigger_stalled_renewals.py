"""Detect and trigger WooCommerce Subscriptions renewals whose scheduled Action
Scheduler action stalled and never ran.

WooCommerce Subscriptions renews a subscription by scheduling a
``woocommerce_scheduled_subscription_payment`` action in Action Scheduler for the
subscription's next payment date. If the Action Scheduler queue runner stalls
(WP-Cron disabled, a stuck "in-progress" claim, PHP timing out mid batch), that
action never fires. The subscription stays active, its next payment date drifts
into the past, and no renewal order and no charge are ever created.

This script finds active subscriptions whose next payment date has passed with no
matching renewal order, and for each one, charges the customer's saved payment
method off session with Stripe and creates the renewal order over the WooCommerce
REST API, the same way the scheduled action would have. Read only by default.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("trigger_stalled_renewals")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
GRACE_HOURS = int(os.environ.get("GRACE_HOURS", "6"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_STATUSES = {"active"}


def stalled_subscriptions():
    """Yield active subscriptions whose next payment date is in the past
    by more than GRACE_HOURS, from the WooCommerce Subscriptions REST API."""
    page = 1
    cutoff = int(time.time()) - GRACE_HOURS * 3600
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
            next_ts = _to_epoch(sub.get("next_payment_date_gmt"))
            if next_ts is not None and next_ts < cutoff:
                yield sub
        page += 1


def _to_epoch(gmt_string):
    if not gmt_string:
        return None
    try:
        return int(time.mktime(time.strptime(gmt_string, "%Y-%m-%dT%H:%M:%S")))
    except ValueError:
        return None


def last_renewal_order(subscription):
    """The most recent renewal order id linked to this subscription, or None."""
    related = subscription.get("_links", {}).get("renewal_orders") or subscription.get("renewal_order_ids") or []
    return related[-1] if related else None


def payment_method_token_of(subscription):
    """The saved Stripe payment method id, from meta _stripe_payment_method or the
    parent order's source_id meta. Returns None when nothing is saved."""
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_payment_method" and meta.get("value"):
            return meta["value"]
    return None


def subscription_amount_minor(subscription):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(subscription["total"]) * 100)


def decide(subscription, has_recent_renewal_order, payment_method_token):
    """Pure decision: what should happen to one stalled subscription.

    Returns a tuple of (action, reason). No I/O happens here, which is what
    makes it safe and fast to unit test.
    """
    if subscription.get("status") not in ACTIVE_STATUSES:
        return ("skip", "subscription is not active")
    if has_recent_renewal_order:
        return ("skip", "a renewal order already exists for this period")
    if not payment_method_token:
        return ("manual", "no saved payment method, needs the customer or manual dunning")
    if float(subscription.get("total", "0")) <= 0:
        return ("skip", "zero cost renewal, no charge needed")
    return ("trigger", "next payment date passed with no renewal order or charge")


def charge_off_session(customer_id, payment_method_token, amount_minor, currency, subscription_id):
    intent = stripe.PaymentIntent.create(
        amount=amount_minor,
        currency=currency,
        customer=customer_id,
        payment_method=payment_method_token,
        off_session=True,
        confirm=True,
        metadata={"subscription_id": str(subscription_id), "reason": "stalled_renewal_trigger"},
    )
    return intent


def create_renewal_order(subscription, intent):
    charge_id = intent.get("latest_charge") or intent["id"]
    r = requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        json={
            "status": "processing",
            "customer_id": subscription["customer_id"],
            "payment_method": subscription.get("payment_method", "stripe"),
            "transaction_id": charge_id,
            "line_items": subscription.get("line_items", []),
            "meta_data": [{"key": "_subscription_renewal", "value": str(subscription["id"])}],
        },
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    order = r.json()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Renewal triggered manually after the scheduled Action Scheduler "
                      f"action stalled. Charged Stripe PaymentIntent {intent['id']}."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    return order


def run():
    triggered = 0
    for subscription in stalled_subscriptions():
        renewal_order_id = last_renewal_order(subscription)
        payment_method_token = payment_method_token_of(subscription)
        action, reason = decide(subscription, renewal_order_id is not None, payment_method_token)
        if action == "skip":
            continue
        if action == "manual":
            log.warning("Subscription %s: %s", subscription["id"], reason)
            continue
        log.info("Subscription %s: %s. %s", subscription["id"], reason, "would trigger" if DRY_RUN else "triggering")
        if not DRY_RUN:
            intent = charge_off_session(
                subscription["customer_id"],
                payment_method_token,
                subscription_amount_minor(subscription),
                subscription.get("currency", "usd").lower(),
                subscription["id"],
            )
            create_renewal_order(subscription, intent)
        triggered += 1
    log.info("Done. %d subscription(s) %s.", triggered, "to trigger" if DRY_RUN else "triggered")


if __name__ == "__main__":
    run()
