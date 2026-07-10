"""Stop Stripe from billing a WooCommerce subscription that was already cancelled.

Cancelling a WooCommerce Subscription only updates the order and the local
subscription post. It does not, by itself, guarantee the linked Stripe
Subscription object gets canceled too. If that second cancel call is skipped,
delayed, or lost, Stripe's billing cycle keeps running and the customer's card
is charged again on the next renewal date even though WooCommerce shows the
subscription as cancelled.

This walks recently cancelled WooCommerce subscriptions, reads the saved
Stripe subscription id from meta, and cancels the Stripe side for any
subscription Stripe still shows as active, trialing, or past_due. Read only
by default (DRY_RUN). Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cancel_stripe_subscription")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# WooCommerce Subscriptions statuses that mean "the shop owner considers this closed."
CANCELLED_WOO_STATUSES = {"cancelled", "pending-cancel", "expired"}

# Stripe subscription statuses that mean Stripe will still try to bill it.
STILL_BILLING_STRIPE_STATUSES = {"active", "trialing", "past_due", "unpaid"}


def stripe_sub_id_of(subscription):
    """The saved Stripe Subscription id, from meta _stripe_subscription_id or
    falling back to the _stripe_intent_id prefix used by some gateway versions.
    """
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_subscription_id" and meta.get("value"):
            return meta["value"]
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            value = meta["value"]
            if value.startswith("sub_"):
                return value
    tid = subscription.get("transaction_id")
    return tid if tid and tid.startswith("sub_") else None


def decide(woo_subscription, stripe_subscription):
    """Pure decision: does the Stripe side need to be canceled?

    woo_subscription    -- the WooCommerce Subscriptions order-like dict for
                            the subscription (has "status" and "meta_data")
    stripe_subscription -- the Stripe Subscription dict (or None if there is
                            no id saved, or Stripe has no record of it)

    Returns a tuple of (action, reason). action is one of:
      "cancel"  -- Woo is cancelled but Stripe is still set to bill, cancel it
      "skip"    -- Woo subscription is not in a cancelled state, leave alone
      "ok"      -- Stripe already agrees the subscription is over
      "orphan"  -- no Stripe subscription id was ever saved, cannot act
    """
    if woo_subscription["status"] not in CANCELLED_WOO_STATUSES:
        return ("skip", "WooCommerce subscription is not cancelled")
    if stripe_subscription is None:
        return ("orphan", "no Stripe subscription id saved on this subscription")
    if stripe_subscription.get("status") in STILL_BILLING_STRIPE_STATUSES:
        return ("cancel", "Woo is cancelled but Stripe would still bill it")
    return ("ok", "Stripe already shows this subscription as over")


def get_stripe_subscription(sub_id):
    if not sub_id:
        return None
    try:
        return stripe.Subscription.retrieve(sub_id)
    except stripe.error.InvalidRequestError:
        return None


def cancelled_woo_subscriptions():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    statuses = ",".join(CANCELLED_WOO_STATUSES)
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": statuses, "modified_after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for subscription in batch:
            yield subscription
        page += 1


def cancel_in_stripe(woo_subscription, stripe_subscription):
    stripe.Subscription.cancel(stripe_subscription["id"])
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{woo_subscription['id']}/notes",
        json={"note": f"Stripe subscription {stripe_subscription['id']} was still {stripe_subscription['status']} "
                      f"after this subscription was cancelled in WooCommerce. Canceled it in Stripe so the "
                      f"customer is not billed again."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for woo_subscription in cancelled_woo_subscriptions():
        sub_id = stripe_sub_id_of(woo_subscription)
        stripe_subscription = get_stripe_subscription(sub_id)
        action, reason = decide(woo_subscription, stripe_subscription)
        if action == "orphan":
            log.warning("Subscription %s has no saved Stripe subscription id", woo_subscription["id"])
            continue
        if action in ("skip", "ok"):
            continue
        log.info("Subscription %s: %s. %s", woo_subscription["id"], reason,
                  "would cancel" if DRY_RUN else "canceling")
        if not DRY_RUN:
            cancel_in_stripe(woo_subscription, stripe_subscription)
        fixed += 1
    log.info("Done. %d subscription(s) %s.", fixed, "to cancel in Stripe" if DRY_RUN else "canceled in Stripe")


if __name__ == "__main__":
    run()
