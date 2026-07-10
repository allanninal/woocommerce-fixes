"""Find and remove invisible auto-draft WooCommerce orders.

The block based checkout, and some older plugins, create an order the moment a
buyer opens the checkout page, before they pay anything. That order sits with
status "auto-draft" (also seen as "checkout-draft"). It never shows in the
Orders list, so nobody notices it, but it stays in the database forever unless
something cleans it up. On a busy store this can be thousands of rows.

This walks orders in those two hidden statuses, skips anything with an
attached Stripe PaymentIntent that is actually in progress or already paid
(so a real, in-flight checkout is never touched), and deletes the rest once
they are older than a safety window. Read only by default. Run on a schedule.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("purge_auto_drafts")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
MAX_AGE_HOURS = int(os.environ.get("MAX_AGE_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DRAFT_STATUSES = {"auto-draft", "checkout-draft"}
IN_PROGRESS_INTENT_STATUSES = {
    "requires_payment_method", "requires_confirmation", "requires_action",
    "processing", "requires_capture", "succeeded",
}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def age_hours(order, now=None):
    now = now if now is not None else time.time()
    created = order.get("date_created_gmt") or order.get("date_created")
    if not created:
        return 0.0
    # Woo returns e.g. "2026-07-09T10:15:00"; treat as UTC.
    created_ts = _parse_iso_utc(created)
    return max(0.0, (now - created_ts) / 3600.0)


def _parse_iso_utc(value):
    import datetime
    dt = datetime.datetime.fromisoformat(value.replace("Z", ""))
    return dt.replace(tzinfo=datetime.timezone.utc).timestamp()


def decide(order, intent, now=None, max_age_hours=MAX_AGE_HOURS):
    """Pure decision: what should happen to one draft order.

    Returns a tuple of (action, reason). action is one of:
      "skip"   - not a draft order, leave it completely alone
      "keep"   - a draft, but still young or tied to a live payment attempt
      "delete" - a stale draft with nothing real behind it, safe to remove
    """
    if order.get("status") not in DRAFT_STATUSES:
        return ("skip", "order is not an auto-draft")
    if intent is not None and intent.get("status") in IN_PROGRESS_INTENT_STATUSES:
        return ("keep", "a Stripe PaymentIntent is still in progress or paid")
    if age_hours(order, now) < max_age_hours:
        return ("keep", "draft is younger than the safety window")
    return ("delete", "stale draft with no live payment attempt")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def draft_orders():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "auto-draft,checkout-draft", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def delete_order(order_id):
    requests.delete(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        params={"force": "true"},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    removed = 0
    for order in draft_orders():
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent)
        if action != "delete":
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would delete" if DRY_RUN else "deleting")
        if not DRY_RUN:
            delete_order(order["id"])
        removed += 1
    log.info("Done. %d order(s) %s.", removed, "to delete" if DRY_RUN else "deleted")


if __name__ == "__main__":
    run()
