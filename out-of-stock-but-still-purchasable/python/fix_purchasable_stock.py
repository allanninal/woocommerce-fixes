"""Repair WooCommerce products that are out of stock but still purchasable,
and check whether any order already slipped through while the catalog was wrong.

A product can end up with stock_status = "outofstock" while purchasable stays
true and catalog_visibility still lists it in the shop, so the buy button
keeps working. This happens most often on variable products, where a
variation sells out but the parent's stock_status is never resynced, or a
stock import writes the quantity but not the status. Two things need fixing:

1. The product itself: lock stock_status, backorders, and catalog_visibility
   so a sold out item cannot be bought again.
2. Any order placed for that product while it was broken: WooCommerce always
   creates the order once checkout completes, so we cross check the order's
   saved Stripe PaymentIntent (from order meta "_stripe_intent_id" or
   transaction_id) to see whether the buyer was actually charged. A real
   charge needs a human decision (fulfil from backorder or refund), so this
   only flags it, it never cancels or refunds by itself.

Safe by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_purchasable_stock")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

SAFE_VISIBILITY = "search"
OPEN_ORDER_STATUSES = {"pending", "processing", "on-hold"}


def is_out_of_stock(product):
    """A product reads as out of stock when stock_status says so, or when
    stock is managed, backorders are not allowed, and the quantity is zero
    or less. Managed stock with backorders allowed is not out of stock."""
    if product.get("stock_status") == "outofstock":
        return True
    if not product.get("manage_stock"):
        return False
    qty = product.get("stock_quantity")
    if qty is None:
        return False
    return qty <= 0 and product.get("backorders", "no") == "no"


def decide_product(product):
    """Pure decision function for a product or variation dict (as returned
    by GET /wp-json/wc/v3/products/{id} or .../variations/{id}). Returns
    (action, reason).

    - "skip": product is in stock, or already locked down correctly.
    - "repair": product is out of stock but still purchasable and/or still
      fully listed, so a buyer could still complete a purchase.
    """
    if not is_out_of_stock(product):
        return ("skip", "product is in stock")

    purchasable = product.get("purchasable", True)
    visibility = product.get("catalog_visibility", "visible")

    if not purchasable and visibility == SAFE_VISIBILITY:
        return ("skip", "already locked down: not purchasable and hidden from the shop")

    return ("repair", "out of stock but still purchasable or still fully listed")


def build_patch():
    """The minimal set of fields to send back to WooCommerce to close the gap.
    Sets stock_status to outofstock (idempotent if already set), forces
    backorders off so purchasing cannot quietly reopen, and drops
    catalog_visibility to "search" so the product page still resolves (no
    broken links, no lost SEO) but it no longer appears in the shop or in
    search-driven upsells."""
    return {
        "stock_status": "outofstock",
        "backorders": "no",
        "catalog_visibility": SAFE_VISIBILITY,
    }


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or
    transaction_id, the same lookup a webhook handler would use."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide_order(order, intent, product_ids_repaired):
    """Pure decision function for an order that contains a line item for a
    product we just found broken. Returns (action, reason).

    - "skip": order does not touch a repaired product, or is not open.
    - "flag_charged": the buyer was actually charged (Stripe shows
      succeeded), so a human needs to fulfil from backorder or refund.
    - "flag_uncharged": the order exists but no successful charge is on
      file, so it is likely safe to cancel without a refund conversation.
    """
    if order["status"] not in OPEN_ORDER_STATUSES:
        return ("skip", "order is not open")

    line_ids = {item["product_id"] for item in order.get("line_items", [])}
    if not line_ids & product_ids_repaired:
        return ("skip", "order does not include a repaired product")

    if intent is not None and intent.get("status") == "succeeded":
        return ("flag_charged", "buyer was charged while the item was out of stock")

    return ("flag_uncharged", "order is open but no succeeded charge is on file")


def list_products():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products",
            params={"per_page": 50, "page": page, "status": "publish"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for product in batch:
            yield product
        page += 1


def list_variations(product_id):
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/products/{product_id}/variations",
            params={"per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for variation in batch:
            yield variation
        page += 1


def recent_open_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "pending,processing,on-hold", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def repair_product(product_id, patch):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}",
        json=patch, auth=AUTH, timeout=30,
    ).raise_for_status()


def repair_variation(product_id, variation_id, patch):
    # Variations have no catalog_visibility of their own, only stock fields.
    variation_patch = {k: v for k, v in patch.items() if k in ("stock_status", "backorders")}
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/products/{product_id}/variations/{variation_id}",
        json=variation_patch, auth=AUTH, timeout=30,
    ).raise_for_status()


def flag_order(order, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Out of stock check: {reason}. This order includes a product that "
                      f"was out of stock but still purchasable. Please review."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repaired_ids = set()

    for product in list_products():
        action, reason = decide_product(product)
        if action == "repair":
            log.warning(
                "Product %s (%s): %s. %s",
                product["id"], product.get("name", ""), reason,
                "would repair" if DRY_RUN else "repairing",
            )
            if not DRY_RUN:
                repair_product(product["id"], build_patch())
            repaired_ids.add(product["id"])

        if product.get("type") == "variable":
            for variation in list_variations(product["id"]):
                v_action, v_reason = decide_product(variation)
                if v_action != "repair":
                    continue
                log.warning(
                    "Variation %s of product %s: %s. %s",
                    variation["id"], product["id"], v_reason,
                    "would repair" if DRY_RUN else "repairing",
                )
                if not DRY_RUN:
                    repair_variation(product["id"], variation["id"], build_patch())
                repaired_ids.add(product["id"])

    flagged = 0
    if repaired_ids:
        for order in recent_open_orders():
            intent = get_intent(intent_id_of(order))
            action, reason = decide_order(order, intent, repaired_ids)
            if action not in ("flag_charged", "flag_uncharged"):
                continue
            log.warning("Order %s: %s. %s", order["id"], reason, "would flag" if DRY_RUN else "flagging")
            if not DRY_RUN:
                flag_order(order, reason)
            flagged += 1

    log.info(
        "Done. %d product/variation(s) %s, %d order(s) %s.",
        len(repaired_ids), "to repair" if DRY_RUN else "repaired",
        flagged, "to flag" if DRY_RUN else "flagged",
    )


if __name__ == "__main__":
    run()
