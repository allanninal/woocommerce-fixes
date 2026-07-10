"""Find WooCommerce Subscriptions with no customer attached, and flag or
repair the ones that are genuinely orphaned.

A subscription is supposed to belong to a WordPress user, stored as
`customer_id` on the subscription. A deleted account, a GDPR erasure
request, a failed account step during signup, or a bad import can leave a
subscription with `customer_id` set to 0 while Stripe is still billing the
saved card behind it every cycle. Nobody notices, because the renewal still
succeeds. This walks recent subscriptions, decides what is wrong with a
pure function, and either reports it (dry run) or repairs it: reattach the
subscription to the WooCommerce user Stripe metadata already names, or flag
it for a human when no such user can be found. Safe by default. Run on a
schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_subscriptions")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_LIKE_STATUSES = {"active", "on-hold", "pending-cancel"}


def intent_id_of(subscription):
    """The saved Stripe PaymentIntent or Subscription id, from meta
    _stripe_intent_id or transaction_id. Either can be used to look up the
    Stripe side and find who Stripe thinks this billing relationship belongs
    to, via metadata.woo_customer_id on the PaymentIntent or the charge.
    """
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = subscription.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(subscription, woo_user_exists, stripe_owner_id):
    """Pure decision function. No I/O, no Stripe or WooCommerce calls inside.

    subscription:      a dict shaped like a WooCommerce Subscription record.
    woo_user_exists:    True if subscription["customer_id"] still points at
                        a real WooCommerce user, False otherwise.
    stripe_owner_id:    the WooCommerce user id named in the Stripe
                        PaymentIntent (or its charge) metadata.woo_customer_id,
                        or None if Stripe has no such metadata or the
                        PaymentIntent could not be found.

    Returns a (action, reason) tuple. Actions:
      "ok"        customer_id is set and that user still exists. Nothing to do.
      "reattach"  customer_id is 0 or points at a deleted user, but Stripe
                  metadata names a WooCommerce user that still exists.
                  Point the subscription at that user.
      "orphan"    customer_id is 0 or points at a deleted user, and Stripe
                  has no usable owner to reattach to. Flag for a human.
      "skip"      the subscription is not in a state worth checking, for
                  example it is already cancelled or a draft.
    """
    status = subscription.get("status")
    if status not in ACTIVE_LIKE_STATUSES:
        return ("skip", "subscription is not in an active-like status")

    customer_id = subscription.get("customer_id") or 0
    if customer_id and woo_user_exists:
        return ("ok", "subscription has a real WooCommerce customer")

    if stripe_owner_id:
        return ("reattach", "Stripe metadata names a WooCommerce user that still exists")

    return ("orphan", "no WooCommerce customer, and Stripe has no owner to reattach to")


def list_subscriptions(lookback_days):
    """WooCommerce Subscriptions created in the lookback window, paged."""
    import datetime
    after = (datetime.date.today() - datetime.timedelta(days=lookback_days)).isoformat() + "T00:00:00"
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for subscription in batch:
            yield subscription
        page += 1


def woo_user_exists(customer_id):
    """True if this WooCommerce customer id still resolves to a real user."""
    if not customer_id:
        return False
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return False
    r.raise_for_status()
    return True


def stripe_owner_of(subscription):
    """The WooCommerce user id Stripe metadata names for this subscription's
    PaymentIntent, or None if there is nothing usable to reattach to.
    """
    intent_id = intent_id_of(subscription)
    if not intent_id:
        return None
    try:
        intent = stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None
    owner_id = (intent.get("metadata") or {}).get("woo_customer_id")
    return owner_id if owner_id else None


def reattach(subscription_id, customer_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}",
        json={"customer_id": int(customer_id)},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Reattached to WooCommerce customer {customer_id} using the owner "
                      f"named in Stripe PaymentIntent metadata. Fixed by the orphan reconciler."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def flag(subscription_id, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription_id}/notes",
        json={"note": f"Orphan check failed: {reason}. This subscription has no WooCommerce "
                      f"customer attached and Stripe has no owner to reattach it to. Please review."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    reattached = 0
    flagged = 0
    for subscription in list_subscriptions(LOOKBACK_DAYS):
        customer_id = subscription.get("customer_id") or 0
        exists = woo_user_exists(customer_id)
        owner_id = None if (customer_id and exists) else stripe_owner_of(subscription)
        action, reason = decide(subscription, exists, owner_id)

        if action in ("ok", "skip"):
            continue

        sub_id = subscription["id"]
        if action == "reattach":
            log.info("Subscription %s: %s. %s", sub_id, reason, "would reattach" if DRY_RUN else "reattaching")
            if not DRY_RUN:
                reattach(sub_id, owner_id)
            reattached += 1
            continue

        log.warning("Subscription %s: %s. %s", sub_id, reason, "would flag" if DRY_RUN else "flagging")
        if not DRY_RUN:
            flag(sub_id, reason)
        flagged += 1

    log.info("Done. %d reattached, %d flagged for review.", reattached, flagged)


if __name__ == "__main__":
    run()
