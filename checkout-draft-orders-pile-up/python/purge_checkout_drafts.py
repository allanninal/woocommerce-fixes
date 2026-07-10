"""Clean out stale WooCommerce checkout-draft orders that never convert to a real order.

The block based checkout (Store API) creates an order in the "checkout-draft" status
the moment a shopper opens the checkout page, before they pay or even enter an
address. Most shoppers who bounce leave that draft behind forever, since nothing in
WooCommerce core ever removes it. This walks old checkout-draft orders, checks
whether an actual payment ever happened, and trashes the ones that are safe to
remove. It also cancels any Stripe PaymentIntent still sitting open for that draft,
so it cannot be captured later by mistake. Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("purge_checkout_drafts")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
STALE_AFTER_HOURS = int(os.environ.get("STALE_AFTER_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DRAFT_STATUS = "checkout-draft"
PAID_INTENT_STATUSES = {"succeeded", "processing"}
OPEN_INTENT_STATUSES = {"requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def age_hours(order, now_ts):
    modified = order.get("date_modified_gmt") or order.get("date_created_gmt")
    if not modified:
        return 0
    import datetime
    dt = datetime.datetime.fromisoformat(modified).replace(tzinfo=datetime.timezone.utc)
    return (now_ts - dt.timestamp()) / 3600


def decide(order, intent, now_ts, stale_after_hours=STALE_AFTER_HOURS):
    """Pure decision: what to do with one checkout-draft order.

    Returns (action, reason). Action is one of:
      "skip"  - not a draft, or too young to touch yet
      "keep"  - a real payment is in flight or already happened, never delete
      "purge" - safe to trash, and cancel any open Stripe intent first
    """
    if order.get("status") != DRAFT_STATUS:
        return ("skip", "order is not a checkout-draft")
    hours_old = age_hours(order, now_ts)
    if hours_old < stale_after_hours:
        return ("skip", "draft is still fresh")
    if intent is not None and intent.get("status") in PAID_INTENT_STATUSES:
        return ("keep", "Stripe shows a real payment on this draft")
    return ("purge", "stale draft with no completed payment")


def cancelable_intent(intent):
    """True when the linked PaymentIntent is still open and safe to cancel."""
    return intent is not None and intent.get("status") in OPEN_INTENT_STATUSES


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def stale_drafts():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": DRAFT_STATUS, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def purge(order, intent):
    if cancelable_intent(intent):
        stripe.PaymentIntent.cancel(intent["id"])
    requests.delete(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        params={"force": "true"},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    import time
    now_ts = time.time()
    purged = 0
    kept = 0
    for order in stale_drafts():
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent, now_ts)
        if action == "skip":
            continue
        if action == "keep":
            log.info("Order %s: %s. Leaving it alone.", order["id"], reason)
            kept += 1
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would purge" if DRY_RUN else "purging")
        if not DRY_RUN:
            purge(order, intent)
        purged += 1
    log.info("Done. %d draft(s) %s, %d kept.", purged, "to purge" if DRY_RUN else "purged", kept)


if __name__ == "__main__":
    run()
