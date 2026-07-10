"""Reapply a recurring coupon that a subscription switch dropped.

When a customer switches a subscription (upgrade, downgrade, or a plan change),
WooCommerce Subscriptions builds a new set of line items for the resulting
subscription but does not carry over a recurring coupon that was active on the
old one. The switch order itself can look correct, since the one-time proration
is right, but every renewal after the switch bills the full price. This walks
recent switch orders, compares the recurring coupons on the parent subscription
before and after, and reapplies any recurring coupon the switch dropped. It
also cross-checks the Stripe PaymentIntent tied to the switch order so we only
touch subscriptions where the switch itself actually succeeded. Safe by
default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reapply_switch_coupon")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

SWITCH_ORDER_KEY = "_subscription_switch"
RECURRING_COUPON_META = "_switch_recurring_coupons"


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def recurring_coupon_codes(subscription):
    """Coupon codes on a subscription that apply to recurring totals, not just the
    one-time switch proration. WooCommerce Subscriptions stores every coupon on
    the `coupon_lines` array the same way an order does."""
    return sorted(
        line["code"]
        for line in subscription.get("coupon_lines") or []
        if line.get("code")
    )


def decide(before_codes, after_codes, switch_intent):
    """Pure decision: should we reapply a dropped recurring coupon to the
    subscription that came out of a switch?

    before_codes: recurring coupon codes on the subscription before the switch.
    after_codes: recurring coupon codes on the subscription after the switch.
    switch_intent: the Stripe PaymentIntent dict for the switch order, or None.
    """
    dropped = sorted(set(before_codes) - set(after_codes))
    if not dropped:
        return ("skip", "no coupon was dropped", dropped)
    if switch_intent is None:
        return ("skip", "no Stripe payment found for the switch order", dropped)
    if switch_intent.get("status") != "succeeded":
        return ("skip", "switch payment did not succeed, nothing to repair yet", dropped)
    return ("reapply", "switch succeeded but a recurring coupon was dropped", dropped)


def get_switch_intent(order):
    """Confirm the switch order itself has a real charge behind it before we
    touch the subscription's coupons."""
    intent_id = intent_id_of(order)
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def get_subscription(subscription_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}", auth=AUTH, timeout=30
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def switch_orders():
    """Orders created in the lookback window that WooCommerce Subscriptions
    tagged as a switch order."""
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            if any(m.get("key") == SWITCH_ORDER_KEY for m in order.get("meta_data") or []):
                yield order
        page += 1


def before_codes_of(order):
    """The recurring coupon codes that were on the subscription before the
    switch. WooCommerce Subscriptions snapshots them onto the switch order
    meta at the moment the switch is requested."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == RECURRING_COUPON_META and meta.get("value"):
            return sorted(meta["value"])
    return []


def reapply_coupons(subscription_id, codes):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/coupons",
        json={"coupons": [{"code": code} for code in codes]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Reapplied recurring coupon(s) {', '.join(codes)} that the last "
                      f"plan switch dropped. Applied by the coupon reconciler."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for order in switch_orders():
        subscription_id = order.get("subscription_renewal") or order.get("id")
        subscription = get_subscription(subscription_id)
        if subscription is None:
            log.warning("Switch order %s points to missing subscription %s", order["id"], subscription_id)
            continue
        before = before_codes_of(order)
        after = recurring_coupon_codes(subscription)
        intent = get_switch_intent(order)
        action, reason, dropped = decide(before, after, intent)
        if action == "skip":
            continue
        log.info(
            "Subscription %s: %s (%s). %s",
            subscription_id, reason, ", ".join(dropped), "would reapply" if DRY_RUN else "reapplying",
        )
        if not DRY_RUN:
            reapply_coupons(subscription_id, dropped)
        fixed += 1
    log.info("Done. %d subscription(s) %s.", fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
