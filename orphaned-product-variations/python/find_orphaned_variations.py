"""Find (and optionally trash) WooCommerce product variations whose parent product
is gone or is no longer a variable product.

A variation is a real "product_variation" post of its own. When its parent product
is deleted, trashed, or its type is changed from variable to simple, WooCommerce does
not always clean up the child variations first. The orphan keeps its own row in
wp_posts and its own entry in the product lookup table, so it can still surface in
search, in stock reports, or on old cart and order line items, even though there is
no parent to load it under.

This walks a list of known variation ids (for example gathered from order line items,
a stock export, or the wp_postmeta table) and checks each one's parent through the
WooCommerce REST API. Read only by default. Run on a schedule or ad hoc after a
product cleanup.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_variations")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Variation ids to check. In practice this list comes from somewhere that still
# remembers old variation ids: an export, a lookup table dump, or order line items.
CANDIDATE_IDS_ENV = os.environ.get("CANDIDATE_VARIATION_IDS", "")


def candidate_ids():
    return [int(v) for v in CANDIDATE_IDS_ENV.split(",") if v.strip()]


def get_parent_of(variation_id):
    """Look up the parent_id WooCommerce has stored for a variation.

    The REST API has no top level /products/variations endpoint, so we ask the
    core /products/<id> endpoint. A variation's own id resolves through the normal
    posts table, and WooCommerce returns parent_id on any product-type response
    that has one, so this call also works when the id belongs to a variation.
    """
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/products/{variation_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_parent_product(parent_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/products/{parent_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def decide(variation, parent):
    """Pure decision: given a variation record and its claimed parent record
    (or None if the lookup failed), decide what to do.

    variation: a dict with at least "id" and "parent_id".
    parent: the parent product dict, or None if it no longer exists.
    """
    if variation is None:
        return ("skip", "variation itself no longer exists")
    parent_id = variation.get("parent_id")
    if not parent_id:
        return ("skip", "not a variation, no parent_id set")
    if parent is None:
        return ("orphan", "parent product no longer exists")
    if parent.get("status") == "trash":
        return ("orphan", "parent product is trashed")
    if parent.get("type") != "variable":
        return ("orphan", "parent product is no longer a variable product")
    return ("ok", "parent exists and is still variable")


def trash_variation(parent_id_hint, variation_id):
    """Move the orphaned variation to trash. We use the variation's own id against
    the generic products endpoint with force=false, which moves it to trash rather
    than deleting permanently, so it can still be restored if this was a mistake.
    """
    requests.delete(
        f"{WOO_URL}/wp-json/wc/v3/products/{variation_id}",
        params={"force": "false"},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    orphaned = 0
    for variation_id in candidate_ids():
        variation = get_parent_of(variation_id)
        parent = get_parent_product(variation["parent_id"]) if variation and variation.get("parent_id") else None
        action, reason = decide(variation, parent)
        if action != "orphan":
            continue
        log.warning("Variation %s: %s. %s", variation_id, reason, "would trash" if DRY_RUN else "trashing")
        if not DRY_RUN:
            trash_variation(variation.get("parent_id"), variation_id)
        orphaned += 1
    log.info("Done. %d orphaned variation(s) %s.", orphaned, "found" if DRY_RUN else "trashed")


if __name__ == "__main__":
    run()
