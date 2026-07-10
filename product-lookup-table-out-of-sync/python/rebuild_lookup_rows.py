"""Find WooCommerce products whose wp_wc_product_meta_lookup row has drifted
from the real product data, and repair them by resaving through the REST API.

Never writes to wp_wc_product_meta_lookup directly. Resaving a product runs
WooCommerce's own save path, which is what rebuilds that row. Run on a
schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/product-lookup-table-out-of-sync/
"""
import os
import datetime
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rebuild_lookup_rows")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
MIN_MISMATCHED_ORDERS = int(os.environ.get("MIN_MISMATCHED_ORDERS", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def recent_paid_orders(lookback_days):
    after = f"{datetime.date.today() - datetime.timedelta(days=lookback_days)}T00:00:00"
    page = 1
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
        yield from batch
        page += 1


def get_product(product_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/products/{product_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def order_line_facts(order):
    """Yield (product_id, unit_minor, discounted, quantity) for each line item."""
    for item in order.get("line_items", []):
        product_id = item.get("product_id")
        if not product_id:
            continue
        quantity = item.get("quantity") or 1
        unit_minor = round(float(item.get("price", 0)) * 100)
        subtotal = item.get("subtotal", item.get("total", 0))
        discounted = float(item.get("total", 0)) != float(subtotal)
        yield product_id, unit_minor, discounted, quantity


def product_price_minor(product):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(product["price"]) * 100)


def decide(product, order_facts, min_mismatched_orders=2):
    """Pure decision function. No I/O.

    order_facts: list of dicts like
    {"order_total_minor": 4500, "stripe_amount_minor": 4500, "discounted": False}
    for recent paid orders that contained this product.

    Returns a (action, reason) tuple where action is one of
    "resave", "ok", or "skip".
    """
    if not product.get("purchasable", True):
        return ("skip", "product is not purchasable")
    if len(order_facts) == 0:
        return ("skip", "no recent paid orders to compare against")

    current_price = product_price_minor(product)
    mismatched = [
        f for f in order_facts
        if not f["discounted"] and abs(f["order_total_minor"] - current_price) > 1
        and abs(f["order_total_minor"] - f["stripe_amount_minor"]) <= 1
    ]

    if len(mismatched) >= min_mismatched_orders:
        return ("resave", "lookup price looks stale against confirmed Stripe charges")
    if product.get("stock_status") == "instock" and product.get("stock_quantity") == 0:
        return ("resave", "lookup shows in stock with zero quantity")
    return ("ok", "lookup data matches recent activity")


def resave_product(product):
    """Send the product's own current values back through the REST API.

    This is intentionally not a raw SQL update. Even a no-op write runs
    WooCommerce's full product save path, which is what rebuilds the
    wp_wc_product_meta_lookup row for this product.
    """
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product['id']}",
        json={
            "regular_price": product.get("regular_price", product["price"]),
            "stock_quantity": product.get("stock_quantity"),
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def collect_order_facts_by_product():
    by_product = {}
    for order in recent_paid_orders(LOOKBACK_DAYS):
        intent = get_intent(intent_id_of(order))
        stripe_amount = intent.get("amount_received") if intent else None
        if stripe_amount is None:
            continue
        for product_id, unit_minor, discounted, quantity in order_line_facts(order):
            by_product.setdefault(product_id, []).append({
                "order_total_minor": unit_minor,
                "stripe_amount_minor": round(stripe_amount / max(quantity, 1)),
                "discounted": discounted,
            })
    return by_product


def run():
    resaved = 0
    facts_by_product = collect_order_facts_by_product()
    for product_id, order_facts in facts_by_product.items():
        product = get_product(product_id)
        if product is None:
            log.warning("Product %s from recent orders is missing now", product_id)
            continue
        action, reason = decide(product, order_facts, MIN_MISMATCHED_ORDERS)
        if action != "resave":
            continue
        log.info("Product %s: %s. %s", product_id, reason, "would resave" if DRY_RUN else "resaving")
        if not DRY_RUN:
            resave_product(product)
        resaved += 1
    log.info("Done. %d product(s) %s.", resaved, "to resave" if DRY_RUN else "resaved")


if __name__ == "__main__":
    run()
