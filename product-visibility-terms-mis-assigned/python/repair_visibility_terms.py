"""Recompute and repair WooCommerce product_visibility terms that have drifted
away from a product's own catalog_visibility, featured, and stock_status fields.

WooCommerce decides what a shopper can see by querying a hidden taxonomy,
product_visibility, built from terms like exclude-from-search, exclude-from-catalog,
featured, and outofstock. Those terms are only ever recomputed when a product goes
through WooCommerce's normal save routine. An import, a bulk edit tool, or a direct
database write can change catalog_visibility, featured, or stock_status without
triggering that recompute, so the terms and the fields disagree and the storefront
follows the (wrong) terms.

This walks every product through the WooCommerce REST API, computes the exact term
set the product's own fields imply, compares it to the terms actually assigned, and
repairs any product where they differ by re-saving its own fields, which forces
WooCommerce to rebuild the terms. Safe by default (dry run). Run once after an
import or bulk edit, or on a schedule as a safety net.

Guide: https://www.allanninal.dev/woocommerce/product-visibility-terms-mis-assigned/
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_visibility_terms")

WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

VALID_CATALOG_VISIBILITY = {"visible", "catalog", "search", "hidden"}


def all_products():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products",
            params={"per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for product in batch:
            yield product
        page += 1


def assigned_visibility_terms(product_id):
    """The product_visibility term slugs currently assigned to this product.

    The core REST API does not expose this taxonomy directly, since WooCommerce
    treats it as internal. Most stores read it through a small custom endpoint, a
    WP-CLI export, or a reporting plugin that lists wp_term_relationships for the
    product_visibility taxonomy. This wraps whatever that source is behind one call
    so the rest of the script does not need to know about it.
    """
    r = requests.get(
        f"{WOO_URL}/wp-json/custom/v1/product-visibility-terms/{product_id}",
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return r.json().get("terms", [])


def expected_terms(product):
    """The exact set of product_visibility term slugs WooCommerce should assign
    for this product's catalog_visibility, featured, and stock_status fields.
    """
    visibility = product.get("catalog_visibility", "visible")
    terms = set()
    # "catalog" means shop only, so search is excluded.
    if visibility in ("catalog", "hidden"):
        terms.add("exclude-from-search")
    # "search" means search only, so the catalog/shop loop is excluded.
    if visibility in ("search", "hidden"):
        terms.add("exclude-from-catalog")
    if product.get("featured"):
        terms.add("featured")
    if product.get("stock_status") == "outofstock":
        terms.add("outofstock")
    return terms


def decide(product, assigned_terms):
    """Pure decision: given a product's own fields and its currently assigned
    product_visibility term slugs, decide what to do.

    product: a dict with at least "catalog_visibility", "featured", "stock_status".
    assigned_terms: an iterable of term slugs currently on the product, or None.

    No network calls happen in here, which is what makes it safe and easy to test.
    """
    visibility = product.get("catalog_visibility", "visible")
    if visibility not in VALID_CATALOG_VISIBILITY:
        return ("skip", "unrecognized catalog_visibility value")
    expected = expected_terms(product)
    assigned = set(assigned_terms or [])
    if expected == assigned:
        return ("ok", "assigned terms match the product's own fields")
    return ("repair", f"expected {sorted(expected)} but found {sorted(assigned)}")


def resync_visibility(product):
    """Re-save the product's own fields so WooCommerce's save routine rebuilds the
    product_visibility terms from scratch. We never write taxonomy terms directly.
    """
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product['id']}",
        json={
            "catalog_visibility": product.get("catalog_visibility", "visible"),
            "featured": bool(product.get("featured")),
            "stock_status": product.get("stock_status", "instock"),
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repaired = 0
    for product in all_products():
        assigned = assigned_visibility_terms(product["id"])
        action, reason = decide(product, assigned)
        if action != "repair":
            continue
        log.warning("Product %s: %s. %s", product["id"], reason, "would resync" if DRY_RUN else "resyncing")
        if not DRY_RUN:
            resync_visibility(product)
        repaired += 1
    log.info("Done. %d product(s) %s.", repaired, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
