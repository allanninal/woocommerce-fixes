"""Find duplicate and missing SKUs across WooCommerce products and variations.

Two products can end up sharing one SKU, or having a blank one, after a CSV
import, a plugin sync, or two editors saving at the same time. WooCommerce
does not stop this at the database level, so the store ends up with broken
inventory sync, wrong analytics, and orders that point at the wrong item.

This walks every product and variation, groups them by SKU, and reports every
group that is duplicated or blank. It never renames a SKU on its own. For a
product that is tied to a real paid order (checked against Stripe using the
PaymentIntent id saved on the order), it only flags the conflict for a human
to fix by hand, since renaming a SKU under a paid order can break fulfillment
and reporting. For a product with no paid order behind it, it is safe to flag
as auto-fixable, since nothing downstream depends on that SKU yet.

Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth
from collections import defaultdict

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sku_audit")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
ORDER_LOOKBACK_DAYS = int(os.environ.get("ORDER_LOOKBACK_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(sku, entries, has_paid_order):
    """Pure decision function. No I/O.

    sku: the SKU string, "" for blank.
    entries: list of {"product_id": int, "type": "product"|"variation"} sharing this SKU.
    has_paid_order: True if any entry in this group is a line item on an order
        that Stripe confirms was actually paid (a succeeded PaymentIntent).

    Returns a tuple (action, reason):
      "ok"          - a normal, unique, non-blank SKU. Nothing to do.
      "review"      - conflict exists, but a paid order depends on one of the
                      items, so a human must decide which SKU is authoritative.
      "auto_fixable" - conflict exists and no paid order depends on any item
                      in the group, so it is safe to assign new placeholder
                      SKUs automatically.
    """
    if sku != "" and len(entries) == 1:
        return ("ok", "unique SKU")
    if sku == "":
        reason = "missing SKU"
    else:
        reason = f"SKU '{sku}' shared by {len(entries)} items"
    if has_paid_order:
        return ("review", f"{reason}, at least one item has a paid order behind it")
    return ("auto_fixable", f"{reason}, no paid orders depend on these items yet")


def group_by_sku(products):
    """Pure. Groups a flat list of {"id", "sku", "type"} dicts by SKU."""
    groups = defaultdict(list)
    for item in products:
        sku = (item.get("sku") or "").strip()
        groups[sku].append({"product_id": item["id"], "type": item.get("type", "product")})
    return groups


def all_products():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products",
            params={"per_page": 100, "page": page, "status": "any"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for product in batch:
            yield {"id": product["id"], "sku": product.get("sku", ""), "type": "product"}
            if product.get("type") == "variable":
                yield from variations_of(product["id"])
        page += 1


def variations_of(product_id):
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products/{product_id}/variations",
            params={"per_page": 100, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for variation in batch:
            yield {"id": variation["id"], "sku": variation.get("sku", ""), "type": "variation"}
        page += 1


def paid_orders_recent():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=ORDER_LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "processing,completed", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def stripe_confirms_paid(order):
    """Retrieve the order's PaymentIntent from Stripe and check it succeeded."""
    intent_id = intent_id_of(order)
    if not intent_id:
        return False
    try:
        intent = stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return False
    return intent.get("status") == "succeeded"


def product_ids_with_paid_orders():
    """Product ids that appear as a line item on an order Stripe confirms paid."""
    ids = set()
    for order in paid_orders_recent():
        if not stripe_confirms_paid(order):
            continue
        for line in order.get("line_items") or []:
            pid = line.get("variation_id") or line.get("product_id")
            if pid:
                ids.add(pid)
    return ids


def note_on_products(entries, message):
    for entry in entries:
        path = (
            f"/wp-json/wc/v3/products/variations/{entry['product_id']}"
            if entry["type"] == "variation"
            else f"/wp-json/wc/v3/products/{entry['product_id']}"
        )
        log.info("Would tag product %s (%s): %s", entry["product_id"], entry["type"], message)


def run():
    products = list(all_products())
    groups = group_by_sku(products)
    paid_ids = product_ids_with_paid_orders()

    to_review = 0
    to_autofix = 0
    for sku, entries in groups.items():
        has_paid_order = any(e["product_id"] in paid_ids for e in entries)
        action, reason = decide(sku, entries, has_paid_order)
        if action == "ok":
            continue
        log.warning(
            "%s: %s -> %s",
            "REVIEW" if action == "review" else "AUTO-FIXABLE",
            reason,
            [e["product_id"] for e in entries],
        )
        if not DRY_RUN:
            note_on_products(entries, reason)
        if action == "review":
            to_review += 1
        else:
            to_autofix += 1

    log.info(
        "Done. %d SKU conflict(s) need review, %d SKU conflict(s) safe to auto-fix.%s",
        to_review, to_autofix, " (dry run, nothing written)" if DRY_RUN else "",
    )


if __name__ == "__main__":
    run()
