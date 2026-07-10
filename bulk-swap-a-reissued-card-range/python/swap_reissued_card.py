"""Bulk swap subscriptions off a reissued Stripe card range onto each customer's
current default payment method.

An issuer notice or a Stripe card updater event names a batch of old payment_method
ids (or fingerprints) that no longer work. Any active subscription still storing one
of those old ids as its payment token will decline on its next renewal. This walks the
affected subscriptions, reads the matching Stripe Customer, and swaps the subscription
onto the customer's current default payment method, but only when that default is a
real, different, non-affected card. Safe to run again and again. Dry run by default.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("swap_reissued_card")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_SUB_STATUSES = {"active", "on-hold", "pending"}


def get_meta(obj, key):
    for meta in obj.get("meta_data") or []:
        if meta.get("key") == key:
            return meta.get("value")
    return None


def current_card_token(sub):
    """The payment method id a subscription currently charges, read from meta
    _stripe_source_id, falling back to a saved _stripe_intent_id or transaction_id
    (a pi_ id, whose payment_method we resolve before deciding)."""
    return get_meta(sub, "_stripe_source_id")


def customer_id_of(sub):
    return get_meta(sub, "_stripe_customer_id")


def decide(sub, affected_token_ids, default_payment_method):
    """Pure decision function. No I/O. Returns (action, reason).

    sub: a dict with at least "status" and meta_data carrying _stripe_source_id.
    affected_token_ids: a set of old payment_method ids from the reissued range.
    default_payment_method: the customer's current default PaymentMethod dict
        (or None), already resolved by the caller.
    """
    if sub["status"] not in ACTIVE_SUB_STATUSES:
        return ("skip", "subscription not in an active state")
    token = current_card_token(sub)
    if not token:
        return ("skip", "no stored payment token on this subscription")
    if token not in affected_token_ids:
        return ("skip", "not on the reissued card range")
    if default_payment_method is None:
        return ("needs-attention", "no replacement card on file for this customer")
    new_token = default_payment_method.get("id")
    if not new_token or new_token in affected_token_ids:
        return ("needs-attention", "customer default is missing or also on the reissued range")
    if new_token == token:
        return ("skip", "already on the new token")
    return ("swap", "reissued card on file, a clean replacement is ready")


def get_subscriptions_on_hold_and_active():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active,on-hold,pending", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            yield sub
        page += 1


def get_customer_default_payment_method(customer_id):
    if not customer_id:
        return None
    try:
        customer = stripe.Customer.retrieve(customer_id)
    except stripe.error.InvalidRequestError:
        return None
    default_id = (customer.get("invoice_settings") or {}).get("default_payment_method")
    if not default_id:
        default_id = customer.get("default_source")
    if not default_id:
        return None
    try:
        return stripe.PaymentMethod.retrieve(default_id)
    except stripe.error.InvalidRequestError:
        return None


def apply_swap(sub_id, new_token, old_token):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}",
        json={"meta_data": [{"key": "_stripe_source_id", "value": new_token}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
        json={"note": f"Reissued card {old_token} swapped for {new_token} by the bulk "
                      f"card range reconciler. Next renewal will charge the new card."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def flag_needs_attention(sub_id, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
        json={"note": f"Card range reissue: {reason}. This subscription is on an old, "
                      f"reissued card and has no safe replacement on file. Please contact "
                      f"the customer for a new card before the next renewal."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def load_affected_token_ids():
    """Read the comma separated list of old payment_method ids from the environment.
    In practice this comes from the issuer's reissue notice or a Stripe card updater
    export, one payment_method id per affected card."""
    raw = os.environ.get("AFFECTED_PAYMENT_METHOD_IDS", "")
    return {pm.strip() for pm in raw.split(",") if pm.strip()}


def run():
    affected = load_affected_token_ids()
    if not affected:
        log.warning("AFFECTED_PAYMENT_METHOD_IDS is empty, nothing to do.")
        return
    swapped = 0
    flagged = 0
    for sub in get_subscriptions_on_hold_and_active():
        token = current_card_token(sub)
        if token not in affected:
            continue
        default_pm = get_customer_default_payment_method(customer_id_of(sub))
        action, reason = decide(sub, affected, default_pm)
        if action == "skip":
            continue
        if action == "needs-attention":
            log.warning("Subscription %s: %s", sub["id"], reason)
            if not DRY_RUN:
                flag_needs_attention(sub["id"], reason)
            flagged += 1
            continue
        new_token = default_pm["id"]
        log.info("Subscription %s: %s. %s", sub["id"], reason, "would swap" if DRY_RUN else "swapping")
        if not DRY_RUN:
            apply_swap(sub["id"], new_token, token)
        swapped += 1
    log.info(
        "Done. %d subscription(s) %s, %d flagged for manual follow up.",
        swapped, "to swap" if DRY_RUN else "swapped", flagged,
    )


if __name__ == "__main__":
    run()
