"""Restore stock for WooCommerce orders that reduced it and then failed or were cancelled.

WooCommerce reduces stock as soon as an order is placed, before payment is confirmed.
When the order later moves to Failed or Cancelled, WooCommerce is supposed to add that
stock back automatically. That restore step can be skipped: a Stripe decline that lands
after a timeout, a status change made through the REST API or an import tool, a plugin
that short circuits the transition, or a restart mid request. The order is left holding
a `_reduced_stock` flag with no matching stock increase, and the product quietly sells
out early.

This walks recent Failed and Cancelled orders, and for any order still flagged as having
reduced stock, adds each line item's quantity back to the matching product or variation
stock and clears the flag. Safe to run again and again: an order with the flag already
cleared is skipped. Read the PaymentIntent id from order meta `_stripe_intent_id`, falling
back to `transaction_id`, only to record it on the restock note, since the Stripe side of
the payment is not required to restore stock. Dry run by default.
"""
import os
import logging
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("restore_failed_stock")

WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

RESTOCK_STATUSES = {"failed", "cancelled"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id.

    Used only to label the restock note. Restoring stock does not depend on Stripe.
    """
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def reduced_stock_flag(order):
    """WooCommerce sets order meta _order_stock_reduced to "1" the moment stock is taken,
    and clears it once wc_maybe_increase_stock_levels() successfully restores it.
    """
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_order_stock_reduced":
            return str(meta.get("value")) == "1"
    return False


def restockable_items(order):
    """Line items with a real product id and a positive quantity to give back."""
    items = []
    for item in order.get("line_items") or []:
        product_id = item.get("variation_id") or item.get("product_id")
        qty = item.get("quantity") or 0
        if product_id and qty > 0:
            items.append({"product_id": product_id, "quantity": qty})
    return items


def decide(order):
    """Pure decision: should this order's stock be restored right now?

    Returns a tuple of (action, reason). No I/O happens here, so this is unit
    tested with plain dicts and no network or WooCommerce store.
    """
    if order["status"] not in RESTOCK_STATUSES:
        return ("skip", "order not failed or cancelled")
    if not reduced_stock_flag(order):
        return ("skip", "stock already restored or never reduced")
    items = restockable_items(order)
    if not items:
        return ("skip", "no line items with stock to restore")
    return ("restore", f"stock reduced but never restored ({len(items)} line item(s))")


def failed_or_cancelled_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "failed,cancelled", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def get_product_stock(product_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/products/{product_id}", auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def restore_stock(order, items, intent_id):
    for item in items:
        product = get_product_stock(item["product_id"])
        if product.get("manage_stock") is not True:
            continue
        current = product.get("stock_quantity") or 0
        new_qty = current + item["quantity"]
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/products/{item['product_id']}",
            json={"stock_quantity": new_qty},
            auth=AUTH, timeout=30,
        ).raise_for_status()
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"meta_data": [{"key": "_order_stock_reduced", "value": "0"}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    note = (
        f"Stock restored by restore_failed_stock. Order stayed {order['status']} with "
        f"reduced stock never given back."
    )
    if intent_id:
        note += f" Stripe PaymentIntent {intent_id}."
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": note},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    restored = 0
    for order in failed_or_cancelled_orders():
        action, reason = decide(order)
        if action != "restore":
            continue
        items = restockable_items(order)
        intent_id = intent_id_of(order)
        log.info("Order %s: %s. %s", order["id"], reason, "would restore" if DRY_RUN else "restoring")
        if not DRY_RUN:
            restore_stock(order, items, intent_id)
        restored += 1
    log.info("Done. %d order(s) %s.", restored, "to restore" if DRY_RUN else "restored")


if __name__ == "__main__":
    run()
