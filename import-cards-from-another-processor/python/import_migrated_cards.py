"""Link cards migrated from an old processor to the right WooCommerce customer.

This does not move card numbers. It reads a mapping file your old processor and
Stripe produced during a card migration (old customer id -> new Stripe
PaymentMethod id), attaches each migrated PaymentMethod to a Stripe Customer, and
saves the new ids on the matching WooCommerce customer. Run once per migration
batch. Safe to run again, since already-linked customers are skipped.

Guide: https://www.allanninal.dev/woocommerce/import-cards-from-another-processor/
"""
import csv
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("import_migrated_cards")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
MAPPING_FILE = os.environ.get("MAPPING_FILE", "migration_mapping.csv")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def mapping_rows(path):
    """Yield {old_customer_id, payment_method_id} dicts from the migration CSV."""
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            yield {
                "old_customer_id": row["old_customer_id"],
                "payment_method_id": row["payment_method_id"],
            }


def find_customer(old_customer_id):
    """Look up the WooCommerce customer that has this old processor id saved."""
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/customers",
        params={
            "meta_key": "_old_processor_customer_id",
            "meta_value": old_customer_id,
            "per_page": 1,
        },
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    results = r.json()
    return results[0] if results else None


def customer_meta(customer, key):
    """Read one meta value off a WooCommerce customer dict."""
    for meta in customer.get("meta_data") or []:
        if meta.get("key") == key:
            return meta.get("value")
    return None


def decide(customer, row):
    """Pure decision: what should happen for this mapping row. No I/O here.

    Returns a (action, reason) tuple where action is one of:
      "orphan" - no WooCommerce customer matches this old processor id
      "skip"   - nothing to do (bad row, or already linked)
      "link"   - attach the migrated PaymentMethod and save the new ids
    """
    if customer is None:
        return ("orphan", "no WooCommerce customer for this old processor id")
    payment_method_id = row.get("payment_method_id")
    if not payment_method_id or not str(payment_method_id).startswith("pm_"):
        return ("skip", "mapping row has no usable Stripe PaymentMethod id")
    existing = customer_meta(customer, "_stripe_payment_method_id")
    if existing:
        return ("skip", "customer already has a linked Stripe PaymentMethod")
    return ("link", "migrated PaymentMethod ready to attach")


def ensure_stripe_customer(customer):
    stripe_id = customer_meta(customer, "_stripe_customer_id")
    if stripe_id:
        return stripe_id
    created = stripe.Customer.create(
        email=customer.get("email"),
        name=f"{customer.get('first_name', '')} {customer.get('last_name', '')}".strip(),
    )
    return created["id"]


def link_payment_method(customer, payment_method_id):
    """Attach the migrated PaymentMethod and save the new ids on the customer."""
    stripe_customer_id = ensure_stripe_customer(customer)
    stripe.PaymentMethod.attach(payment_method_id, customer=stripe_customer_id)
    stripe.Customer.modify(
        stripe_customer_id,
        invoice_settings={"default_payment_method": payment_method_id},
    )
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/customers/{customer['id']}",
        json={
            "meta_data": [
                {"key": "_stripe_customer_id", "value": stripe_customer_id},
                {"key": "_stripe_payment_method_id", "value": payment_method_id},
            ]
        },
        auth=AUTH,
        timeout=30,
    ).raise_for_status()


def run():
    linked = 0
    for row in mapping_rows(MAPPING_FILE):
        customer = find_customer(row["old_customer_id"])
        action, reason = decide(customer, row)
        if action == "orphan":
            log.warning(
                "Old customer %s has no matching WooCommerce customer",
                row["old_customer_id"],
            )
            continue
        if action == "skip":
            log.info("Old customer %s: %s", row["old_customer_id"], reason)
            continue
        log.info(
            "Customer %s: %s. %s",
            customer["id"],
            reason,
            "would link" if DRY_RUN else "linking",
        )
        if not DRY_RUN:
            link_payment_method(customer, row["payment_method_id"])
        linked += 1
    log.info("Done. %d customer(s) %s.", linked, "to link" if DRY_RUN else "linked")


if __name__ == "__main__":
    run()
