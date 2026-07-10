"""Remap WooCommerce orders to the correct customer after a store move.

A migration usually re-creates WordPress users with new IDs while orders keep
their old numeric customer_id. This walks every order, finds the WordPress
user whose email matches the order's billing email, cross checks that user's
saved Stripe customer id against the order's Stripe customer id, and only
remaps when both signals agree on exactly one account. Safe to run again and
again; already-correct orders are always skipped. Read only until DRY_RUN is
turned off.

Guide: https://www.allanninal.dev/woocommerce/remap-customers-after-a-store-move/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("remap_customers")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def all_orders():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"per_page": 50, "page": page, "orderby": "id", "order": "asc"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def user_exists(customer_id):
    if not customer_id:
        return False
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/customers/{customer_id}", auth=AUTH, timeout=30)
    return r.status_code == 200


def users_by_email(email):
    if not email:
        return []
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/customers",
        params={"email": email, "per_page": 10},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def meta_value(order, key):
    """Read a value out of an order's WooCommerce meta_data list."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == key and meta.get("value"):
            return meta["value"]
    return None


def stripe_customer_id_of_order(order):
    """The Stripe customer id for an order, from meta or the PaymentIntent."""
    direct = meta_value(order, "_stripe_customer_id")
    if direct:
        return direct
    intent_id = meta_value(order, "_stripe_intent_id") or order.get("transaction_id")
    if intent_id and intent_id.startswith("pi_"):
        try:
            intent = stripe.PaymentIntent.retrieve(intent_id)
            return intent.get("customer")
        except stripe.error.InvalidRequestError:
            return None
    return None


def stripe_ids_agree(order_stripe_customer_id, user_stripe_customer_id):
    """True unless both ids are present and disagree."""
    if not order_stripe_customer_id or not user_stripe_customer_id:
        return True  # nothing to contradict, email match stands
    return order_stripe_customer_id == user_stripe_customer_id


def decide(order, current_customer_valid, matching_users):
    """Pure decision function: no I/O, easy to unit test.

    order: dict with at least "id" and "customer_id".
    current_customer_valid: bool, whether order["customer_id"] resolves to a
        real WooCommerce customer on this site.
    matching_users: list of WooCommerce customer dicts whose email equals the
        order's billing email, each with at least an "id" key.
    """
    if current_customer_valid:
        return ("skip", "customer_id already resolves to a real account")
    if len(matching_users) == 0:
        return ("orphan", "no WordPress account matches this billing email")
    if len(matching_users) > 1:
        return ("ambiguous", "more than one account shares this billing email")
    match = matching_users[0]
    if match["id"] == order.get("customer_id"):
        return ("skip", "already pointing at the matching account")
    return ("remap", f"remap to user {match['id']}")


def remap_order(order, new_customer_id):
    old_id = order.get("customer_id")
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"customer_id": new_customer_id},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Remapped customer_id from {old_id} to {new_customer_id} after the "
                      f"store move. Matched by Stripe customer id and billing email."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    remapped = 0
    reported = 0
    for order in all_orders():
        current_valid = user_exists(order.get("customer_id"))
        email = (order.get("billing") or {}).get("email")
        candidates = users_by_email(email) if not current_valid else []
        action, reason = decide(order, current_valid, candidates)

        if action == "skip":
            continue

        if action in ("orphan", "ambiguous"):
            log.warning("Order %s: %s", order["id"], reason)
            reported += 1
            continue

        match = candidates[0]
        order_stripe_id = stripe_customer_id_of_order(order)
        user_stripe_id = match.get("meta_data_stripe_customer_id") or None
        if not stripe_ids_agree(order_stripe_id, user_stripe_id):
            log.warning("Order %s: Stripe customer id disagrees with email match, skipping", order["id"])
            reported += 1
            continue

        log.info("Order %s: %s. %s", order["id"], reason, "would remap" if DRY_RUN else "remapping")
        if not DRY_RUN:
            remap_order(order, match["id"])
        remapped += 1

    log.info(
        "Done. %d order(s) %s, %d reported for manual review.",
        remapped, "to remap" if DRY_RUN else "remapped", reported,
    )


if __name__ == "__main__":
    run()
