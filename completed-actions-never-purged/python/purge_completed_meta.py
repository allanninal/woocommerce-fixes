"""Purge stale WooCommerce reconciliation meta left behind on long settled orders.

Action Scheduler's own daily cleanup should remove old completed and canceled
actions, but it depends on WP-Cron firing reliably and a batch size that can
keep up with the store's volume. When it falls behind, both the
actionscheduler_actions table and ad hoc reconciliation meta written onto
orders by past webhook-repair and payment-verification scripts pile up
forever. This walks settled orders past a retention window, re-confirms the
linked Stripe PaymentIntent, and only purges the stale meta once Stripe still
agrees the order is genuinely paid and settled. Read only by default (dry
run). Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/completed-actions-never-purged/
"""
import os
import logging
from datetime import datetime, timedelta, timezone
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("purge_completed_meta")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}
PURGEABLE_META_KEYS = {"_reconciler_checked_at", "_webhook_repair_log", "_payment_verify_pass"}


def settled_orders(retention_days):
    """Yield paid orders last modified before the retention window."""
    before = (datetime.now(timezone.utc) - timedelta(days=retention_days)).strftime("%Y-%m-%dT%H:%M:%S")
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": ",".join(PAID_STATUSES), "before": before, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def purgeable_meta_ids(order):
    """IDs of the leftover reconciliation meta rows on this order, if any."""
    return [m["id"] for m in (order.get("meta_data") or []) if m.get("key") in PURGEABLE_META_KEYS]


def order_amount_minor(order):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(order["total"]) * 100)


def decide(order, intent, retention_days, now=None):
    """Pure decision: what to do with an order's stale reconciliation meta.

    No I/O. Takes plain dicts so it is easy to unit test.
    """
    now = now or datetime.now(timezone.utc)
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order not in a settled state")
    meta_ids = purgeable_meta_ids(order)
    if not meta_ids:
        return ("skip", "nothing to purge")
    modified = datetime.fromisoformat(order["date_modified_gmt"].replace("Z", "+00:00")).replace(tzinfo=timezone.utc)
    if now - modified < timedelta(days=retention_days):
        return ("skip", "inside the retention window")
    if intent is None or intent.get("status") != "succeeded":
        return ("keep", "Stripe no longer confirms a succeeded payment")
    if abs(order_amount_minor(order) - intent.get("amount_received", 0)) > 1:
        return ("keep", "amount no longer matches the Stripe charge")
    return ("purge", "settled, past retention, Stripe still confirms the payment")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def purge_meta(order_id, meta_ids):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"meta_data": [{"id": mid, "value": None} for mid in meta_ids]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Purged {len(meta_ids)} stale reconciliation meta row(s) past the retention "
                      f"window. Stripe still confirms the payment, so the order itself is unchanged."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    purged = 0
    kept = 0
    for order in settled_orders(RETENTION_DAYS):
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent, RETENTION_DAYS)
        if action == "skip":
            continue
        if action == "keep":
            log.warning("Order %s: %s. Leaving meta in place.", order["id"], reason)
            kept += 1
            continue
        meta_ids = purgeable_meta_ids(order)
        log.info("Order %s: %s. %s", order["id"], reason, "would purge" if DRY_RUN else "purging")
        if not DRY_RUN:
            purge_meta(order["id"], meta_ids)
        purged += 1
    log.info("Done. %d order(s) %s, %d kept for review.", purged, "to purge" if DRY_RUN else "purged", kept)


if __name__ == "__main__":
    run()
