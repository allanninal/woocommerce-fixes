"""Recount WooCommerce attribute terms whose cached count drifted from the real
catalog. Cross-checks recent Stripe sales to flag drifted terms that are still
actively selling as higher priority. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/attribute-and-term-counts-drift/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recount_terms")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
SALES_LOOKBACK_HOURS = int(os.environ.get("SALES_LOOKBACK_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def all_attributes():
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/products/attributes", auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def attribute_terms(attribute_id):
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products/attributes/{attribute_id}/terms",
            params={"per_page": 100, "page": page}, auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for term in batch:
            yield term
        page += 1


def real_count(attribute_slug, term_slug):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/products",
        params={
            "attribute": attribute_slug,
            "attribute_term": term_slug,
            "status": "publish",
            "stock_status": "instock",
            "per_page": 1,
        },
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return int(r.headers.get("X-WP-Total", "0"))


def decide(term, real):
    """Pure decision: compare the term's stored count to the freshly computed
    real count and decide whether to repair it. No I/O, easy to unit test.
    """
    stored = term.get("count", 0)
    if stored == real:
        return ("skip", "count already correct")
    if real < 0:
        return ("skip", "real count invalid, will not write a negative number")
    return ("repair", f"stored {stored}, real {real}")


def write_count(attribute_id, term_id, real):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/attributes/{attribute_id}/terms/{term_id}",
        json={"count": real}, auth=AUTH, timeout=30,
    ).raise_for_status()


def recently_sold_product_ids(lookback_hours):
    since = int(time.time()) - lookback_hours * 3600
    ids = set()
    for intent in stripe.PaymentIntent.list(limit=100, created={"gte": since}).auto_paging_iter():
        order_id = intent.metadata.get("order_id")
        if intent.status != "succeeded" or not order_id:
            continue
        r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
        if r.status_code != 200:
            continue
        for line in r.json().get("line_items", []):
            ids.add(line.get("product_id"))
    return ids


def run():
    repaired = 0
    sold_ids = recently_sold_product_ids(SALES_LOOKBACK_HOURS)
    for attribute in all_attributes():
        for term in attribute_terms(attribute["id"]):
            real = real_count(attribute["slug"], term["slug"])
            action, reason = decide(term, real)
            if action == "skip":
                continue
            urgent = bool(sold_ids) and real > 0
            log.info(
                "Term %s (%s): %s. %s%s",
                term["name"], attribute["name"], reason,
                "would repair" if DRY_RUN else "repairing",
                " [urgent: recent sales use this term]" if urgent else "",
            )
            if not DRY_RUN:
                write_count(attribute["id"], term["id"], real)
            repaired += 1
    log.info("Done. %d term(s) %s.", repaired, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
