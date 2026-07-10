"""Find WooCommerce saved cards that the new checkout cannot charge, and clear them
so the shopper is prompted to re-enter their card instead of hitting a silent decline.

Stores that upgraded from the legacy Stripe checkout (Sources/Cards tokens saved
straight onto the order) to the new checkout (Payment Element, SCA-ready, backed by
`PaymentMethod` objects attached to a Stripe Customer) can be left with WooCommerce
payment tokens that still look valid in "My account" but are not attached to any
Stripe Customer, or were never converted to a real `pm_...` PaymentMethod. The new
checkout tries to reuse them for a saved-card purchase and Stripe returns an error
such as "PaymentMethod was previously used without being attached to a Customer &
Setup Intent" or "No such PaymentMethod". The shopper sees a failed order for a card
that "should just work".

This script reads each customer's saved WooCommerce payment tokens, looks up the
matching object on Stripe, and decides whether the token is safe to keep, needs to
be dropped (the shopper re-enters their card next time), or should be left alone
because it is already a healthy PaymentMethod. Safe by default (DRY_RUN=true). Run
on a schedule, or once after a checkout migration.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_legacy_tokens")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"), os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

LEGACY_TOKEN_PREFIXES = ("src_", "card_")
PAYMENT_METHOD_PREFIX = "pm_"


def gateway_id_of(token):
    """The raw Stripe id WooCommerce stored for this saved payment token."""
    return (token.get("token") or "").strip() or None


def is_legacy_shaped(gateway_id):
    """True when the id is from the old Sources/Cards world, not a PaymentMethod."""
    return bool(gateway_id) and gateway_id.startswith(LEGACY_TOKEN_PREFIXES)


def is_payment_method_shaped(gateway_id):
    return bool(gateway_id) and gateway_id.startswith(PAYMENT_METHOD_PREFIX)


def decide(token, stripe_object):
    """Pure decision: what should we do with one saved WooCommerce payment token.

    token: dict with at least "token" (the Stripe id WooCommerce saved) and
           "is_default" (bool). Shape matches customers/{id}/payment_tokens.
    stripe_object: the retrieved Stripe object for that id (a PaymentMethod dict,
                   a legacy Source dict), or None when Stripe has no record of it
                   or the id was never even a Stripe id.

    Returns (action, reason):
      "keep"  - a real PaymentMethod, attached to a customer, still usable
      "drop"  - the new checkout cannot charge this safely, remove the token
      "skip"  - nothing we recognize as a saved card token, leave it alone
    """
    gateway_id = gateway_id_of(token)
    if not gateway_id:
        return ("skip", "token has no gateway id")

    if is_payment_method_shaped(gateway_id):
        if stripe_object is None:
            return ("drop", "PaymentMethod no longer exists on Stripe")
        if not stripe_object.get("customer"):
            return ("drop", "PaymentMethod exists but is not attached to a Stripe Customer")
        return ("keep", "attached PaymentMethod, safe for the new checkout")

    if is_legacy_shaped(gateway_id):
        if stripe_object is None:
            return ("drop", "legacy token no longer exists on Stripe")
        if stripe_object.get("object") == "source" and stripe_object.get("status") != "chargeable":
            return ("drop", "legacy Source is no longer chargeable")
        return ("drop", "legacy Source or Card token, the new checkout cannot reuse it")

    return ("skip", "not a recognized Stripe token shape")


def get_stripe_object(gateway_id):
    if not gateway_id:
        return None
    try:
        if is_payment_method_shaped(gateway_id):
            return stripe.PaymentMethod.retrieve(gateway_id)
        return stripe.Source.retrieve(gateway_id)
    except stripe.error.InvalidRequestError:
        return None


def customers_with_tokens():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/customers",
            params={"per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for customer in batch:
            yield customer
        page += 1


def get_tokens(customer_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}/payment_tokens",
        auth=AUTH, timeout=30,
    )
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return r.json()


def drop_token(customer_id, token_id, reason):
    requests.delete(
        f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}/payment_tokens/{token_id}",
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}/notes",
        json={"note": f"Removed a saved card that the new checkout could not reuse: {reason}. "
                      f"The shopper will be asked to re-enter their card on the next purchase."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    dropped = 0
    checked = 0
    for customer in customers_with_tokens():
        for token in get_tokens(customer["id"]):
            checked += 1
            gateway_id = gateway_id_of(token)
            stripe_object = get_stripe_object(gateway_id)
            action, reason = decide(token, stripe_object)
            if action != "drop":
                continue
            log.info(
                "Customer %s token %s: %s. %s",
                customer["id"], token.get("id"), reason,
                "would drop" if DRY_RUN else "dropping",
            )
            if not DRY_RUN:
                drop_token(customer["id"], token["id"], reason)
            dropped += 1
    log.info("Done. Checked %d token(s). %d %s.", checked, dropped, "to drop" if DRY_RUN else "dropped")


if __name__ == "__main__":
    run()
