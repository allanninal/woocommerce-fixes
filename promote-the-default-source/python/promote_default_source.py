"""Promote a customer's default Source to a matching PaymentMethod.

A customer whose default payment is still a legacy Source cannot be charged
off session under SCA. This walks customers behind active or on hold
subscriptions, finds anyone whose Stripe default is a Source, looks for an
attached PaymentMethod with a matching card fingerprint, and promotes it to
invoice_settings.default_payment_method. Read only by default. Safe to run
again and again, since a customer already on a PaymentMethod is skipped.

Guide: https://www.allanninal.dev/woocommerce/promote-the-default-source/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("promote_default_source")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def meta_value(obj, key):
    """Read a value out of a WooCommerce meta_data list by key."""
    for m in obj.get("meta_data") or []:
        if m.get("key") == key:
            return m.get("value")
    return None


def active_subscription_customers():
    """Yield each distinct Stripe customer id behind an active or on-hold subscription."""
    page = 1
    seen = set()
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "active,on-hold", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            customer_id = meta_value(sub, "_stripe_customer_id")
            if customer_id and customer_id not in seen:
                seen.add(customer_id)
                yield customer_id
        page += 1


def load_customer_state(customer_id):
    """Fetch the Stripe customer and their attached card PaymentMethods."""
    customer = stripe.Customer.retrieve(customer_id)
    methods = stripe.PaymentMethod.list(customer=customer_id, type="card")
    return customer, list(methods.auto_paging_iter())


def source_fingerprint(source_id):
    """Return the card fingerprint of a legacy Source, or None if not a Source."""
    if not source_id or not source_id.startswith("src_"):
        return None
    source = stripe.Source.retrieve(source_id)
    return (source.get("card") or {}).get("fingerprint")


def decide(default_id, default_fingerprint, payment_methods):
    """Pure decision: what to do about a customer's current default payment.

    Returns a tuple of (action, detail):
      - ("no_default", reason)  nothing set, nothing to do
      - ("skip", reason)        already a PaymentMethod, or an unknown object type
      - ("no_match", reason)    a legacy Source with no matching PaymentMethod
      - ("promote", pm_id)      a legacy Source with a matching PaymentMethod to promote
    """
    if not default_id:
        return ("no_default", "customer has no default payment set")
    if default_id.startswith("pm_"):
        return ("skip", "default is already a PaymentMethod")
    if not default_id.startswith("src_"):
        return ("skip", "default is neither a Source nor a PaymentMethod")

    matches = [
        pm for pm in payment_methods
        if default_fingerprint is not None
        and pm.get("card", {}).get("fingerprint") == default_fingerprint
    ]
    if not matches:
        return ("no_match", "default is a legacy Source with no matching PaymentMethod")

    # Prefer the most recently created match if more than one exists.
    best = max(matches, key=lambda pm: pm.get("created", 0))
    return ("promote", best["id"])


def promote_default(customer_id, payment_method_id):
    """Set the given PaymentMethod as the customer's default for invoices and renewals."""
    stripe.Customer.modify(
        customer_id,
        invoice_settings={"default_payment_method": payment_method_id},
    )


def run():
    promoted = 0
    unresolved = 0
    for customer_id in active_subscription_customers():
        customer, methods = load_customer_state(customer_id)
        default_id = (customer.get("invoice_settings") or {}).get("default_payment_method") \
            or customer.get("default_source")
        fingerprint = source_fingerprint(default_id)
        action, payload = decide(default_id, fingerprint, methods)

        if action in ("skip", "no_default"):
            continue
        if action == "no_match":
            log.warning("Customer %s: %s", customer_id, payload)
            unresolved += 1
            continue

        log.info(
            "Customer %s: promoting %s over %s. %s",
            customer_id, payload, default_id, "would promote" if DRY_RUN else "promoting",
        )
        if not DRY_RUN:
            promote_default(customer_id, payload)
        promoted += 1

    log.info(
        "Done. %d customer(s) %s, %d unresolved (no matching PaymentMethod).",
        promoted, "to promote" if DRY_RUN else "promoted", unresolved,
    )


if __name__ == "__main__":
    run()
