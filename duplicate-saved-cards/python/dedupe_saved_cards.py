"""Find WooCommerce customers with the same card saved more than once on Stripe.

A retried checkout, a re-added card during a plan upgrade, or a customer portal
session can all attach a fresh Stripe PaymentMethod for a card that the customer
already has on file. Stripe never merges these for you, so the same card sits on
the customer two, three, sometimes five times. This walks each customer's saved
cards, groups them by card fingerprint, keeps the one WooCommerce actually uses
for renewals (or the newest one if none is in use), and detaches the rest.
Read only by default. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/duplicate-saved-cards/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dedupe_saved_cards")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def tokens_in_use(customer_id):
    """Every Stripe PaymentMethod id this WooCommerce customer's active
    subscriptions rely on for renewals. These are never candidates for removal.
    """
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions",
        params={"customer": customer_id, "status": "active,on-hold", "per_page": 100},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    used = set()
    for sub in r.json():
        for meta in sub.get("meta_data") or []:
            if meta.get("key") == "_stripe_source_id" and meta.get("value"):
                used.add(meta["value"])
    return used


def group_by_fingerprint(payment_methods):
    """Group a customer's saved cards by Stripe's card fingerprint. Two
    PaymentMethod objects that share a fingerprint are the same physical card,
    regardless of how many times it was re-added.
    """
    groups = {}
    for pm in payment_methods:
        card = pm.get("card") or {}
        fingerprint = card.get("fingerprint")
        if not fingerprint:
            continue
        groups.setdefault(fingerprint, []).append(pm)
    return groups


def decide(group, used_token_ids):
    """Given every saved card that shares one fingerprint, decide what to do
    with each PaymentMethod id. Returns a dict of payment_method_id -> action,
    where action is "keep" or "detach". Pure: no I/O, no Stripe or Woo calls.

    Rule: a single card is left alone. Among duplicates, any card already
    wired to an active subscription is always kept, never detached, even if
    it is not the newest. If more than one duplicate is in use (a rare split
    subscription setup), keep all of those and only detach the unused ones.
    If none are in use, keep the most recently created card and detach the
    rest, since the newest one is the one the customer most likely intended
    to keep.
    """
    if len(group) < 2:
        return {pm["id"]: "keep" for pm in group}

    in_use = [pm for pm in group if pm["id"] in used_token_ids]
    if in_use:
        keep_ids = {pm["id"] for pm in in_use}
    else:
        newest = max(group, key=lambda pm: pm.get("created", 0))
        keep_ids = {newest["id"]}

    return {pm["id"]: ("keep" if pm["id"] in keep_ids else "detach") for pm in group}


def saved_cards(customer_id):
    return stripe.PaymentMethod.list(customer=customer_id, type="card").auto_paging_iter()


def detach(payment_method_id):
    stripe.PaymentMethod.detach(payment_method_id)


def woo_customers_with_stripe_id():
    """Every WooCommerce customer that has a Stripe customer id saved, paging
    through the REST API.
    """
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
            stripe_id = next(
                (m["value"] for m in customer.get("meta_data") or []
                 if m.get("key") == "_stripe_customer_id" and m.get("value")),
                None,
            )
            if stripe_id:
                yield customer["id"], stripe_id
        page += 1


def run():
    detached = 0
    for woo_customer_id, stripe_customer_id in woo_customers_with_stripe_id():
        methods = list(saved_cards(stripe_customer_id))
        groups = group_by_fingerprint(methods)
        used = tokens_in_use(woo_customer_id)
        for fingerprint, group in groups.items():
            if len(group) < 2:
                continue
            actions = decide(group, used)
            for pm_id, action in actions.items():
                if action != "detach":
                    continue
                log.info(
                    "Customer %s: duplicate card %s (fingerprint %s...). %s",
                    woo_customer_id, pm_id, fingerprint[:8],
                    "would detach" if DRY_RUN else "detaching",
                )
                if not DRY_RUN:
                    detach(pm_id)
                detached += 1
    log.info("Done. %d duplicate card(s) %s.", detached, "to detach" if DRY_RUN else "detached")


if __name__ == "__main__":
    run()
