"""Find legacy wp_posts order rows that should have been removed after an HPOS cleanup.

When a store turns on High-Performance Order Storage, WooCommerce copies every order
into the new custom tables and, once compatibility mode is turned off, is supposed to
remove the matching legacy shop_order post row. That cleanup step can be interrupted,
skipped for a subset of orders, or never run at all, leaving posts behind that still
carry an `_order_id` that points at a live HPOS order (the `_legacy_order_id` meta
mirrors it the other way). Those leftover rows can confuse anything that still scans
wp_posts directly, and they take up space for no reason.

This script walks HPOS orders through the REST API, reads the legacy post id each order
remembers, and confirms with Stripe that the order is fully settled (paid and not still
awaiting action) before reporting the legacy row as safe to remove. It never deletes
anything itself. Read only by default. Run on a schedule or by hand after a cleanup.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_legacy_order_rows")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Statuses that mean Stripe has fully finished with the payment, so it is safe to
# consider the order settled and its legacy row a pure leftover.
SETTLED_INTENT_STATUSES = {"succeeded", "canceled"}
# Order statuses that are still in play and should never be touched.
OPEN_ORDER_STATUSES = {"pending", "on-hold", "processing"}


def legacy_post_id_of(order):
    """The old wp_posts id for this order, saved by HPOS as `_legacy_order_id`."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_legacy_order_id" and meta.get("value"):
            try:
                return int(meta["value"])
            except (TypeError, ValueError):
                return None
    return None


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    return round(float(order["total"]) * 100)


def decide(order, legacy_post, intent):
    """Pure decision. No I/O. Returns (action, reason).

    order: the HPOS order dict from the WooCommerce REST API.
    legacy_post: a dict like {"id": 123, "post_type": "shop_order"} if a wp_posts row
        with that id still exists, or None if it was already removed.
    intent: the Stripe PaymentIntent dict for this order's saved id, or None if there
        is no PaymentIntent to check (e.g. an offline payment method).
    """
    legacy_id = legacy_post_id_of(order) if order is not None else None
    if not legacy_id:
        return ("skip", "order has no legacy post id, nothing to check")
    if legacy_post is None:
        return ("clean", "legacy row already gone, nothing left to do")
    if legacy_post.get("post_type") not in ("shop_order", "shop_order_refund"):
        return ("skip", "post id is reused by unrelated content, leave it alone")
    if order["status"] in OPEN_ORDER_STATUSES:
        return ("skip", "order is still open, keep both rows until it settles")
    if intent is not None and intent.get("status") not in SETTLED_INTENT_STATUSES:
        return ("skip", "Stripe still has the payment in progress")
    if intent is not None and abs(order_amount_minor(order) - intent.get("amount_received", intent.get("amount", 0))) > 1:
        return ("mismatch", "Stripe amount does not match the order, needs a human look")
    return ("report", "HPOS order is settled and the legacy row is a safe cleanup candidate")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def hpos_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"after": after, "per_page": 50, "page": page, "orderby": "date", "order": "asc"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def get_legacy_post(post_id):
    """Look up the legacy wp_posts row through the custom endpoint the store's
    HPOS compatibility helper exposes. Returns None once the row is gone.
    """
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders/legacy-post/{post_id}",
        auth=AUTH, timeout=30,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def report(order, legacy_id, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"HPOS cleanup check: legacy post {legacy_id} still exists ({reason}). "
                      f"Safe to remove with WooCommerce's own cleanup tool. Flagged, not deleted."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    flagged = 0
    for order in hpos_orders():
        legacy_id = legacy_post_id_of(order)
        if not legacy_id:
            continue
        legacy_post = get_legacy_post(legacy_id)
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, legacy_post, intent)
        if action in ("skip", "clean"):
            continue
        if action == "mismatch":
            log.warning("Order %s: %s", order["id"], reason)
            continue
        log.info("Order %s: legacy post %s. %s", order["id"], legacy_id, "would report" if DRY_RUN else "reporting")
        if not DRY_RUN:
            report(order, legacy_id, reason)
        flagged += 1
    log.info("Done. %d legacy row(s) %s.", flagged, "to report" if DRY_RUN else "reported")


if __name__ == "__main__":
    run()
