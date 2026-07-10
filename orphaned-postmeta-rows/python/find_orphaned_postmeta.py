"""Find WooCommerce postmeta rows that point at an order which no longer exists.

Every order keeps its Stripe link in postmeta, in the key ``_stripe_intent_id``, or
in the ``transaction_id`` column when the plugin writes it there instead. When an
order is deleted straight from wp_posts (a manual cleanup script, a bad SQL DELETE,
a plugin that skips ``wp_delete_post``'s meta cleanup) the postmeta row can survive
with nothing left to attach to. That row is now orphaned: it takes up space, it can
resurface in stale reports, and on some pages it drags in a Stripe API call for an
order the shop can never show you.

This script does not scan the database directly. It walks Stripe PaymentIntents,
since Stripe is the durable record of "an order used to exist here", and checks the
WooCommerce REST API to see whether the order it points to is still there. Anything
missing is an orphan candidate. Read only by default. Run on a schedule.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_postmeta")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "90"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(order, intent):
    """Pure decision: no I/O, only plain data in, one action out.

    order is None when the WooCommerce REST API has nothing at that id, which is
    exactly what happens when the post row was deleted but a Stripe PaymentIntent
    still carries metadata.order_id pointing at it. That is the orphan we report.
    """
    if intent is None:
        return ("skip", "no Stripe intent to check")
    order_id = intent.get("metadata", {}).get("order_id")
    if not order_id:
        return ("skip", "intent has no order_id in metadata")
    if order is None:
        return ("orphan", f"order {order_id} is gone but Stripe still references it")
    if str(order.get("id")) != str(order_id):
        return ("skip", "order id mismatch, not our concern here")
    return ("ok", "order still exists")


def recent_intents(lookback_days):
    since = int(time.time()) - lookback_days * 86400
    for intent in stripe.PaymentIntent.list(limit=100, created={"gte": since}).auto_paging_iter():
        if intent.metadata.get("order_id"):
            yield intent


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def report_orphan(order_id, intent, reason):
    """Read only: write a line to the log. This never deletes anything on its own.

    Cleaning the leftover postmeta rows is a database job (DELETE FROM wp_postmeta
    WHERE post_id NOT IN (SELECT ID FROM wp_posts)), which is outside what a REST
    API script should attempt. This function's job is to hand the shop a precise,
    reviewed list so that cleanup step is safe to run.
    """
    log.warning(
        "Orphan candidate: order %s, PaymentIntent %s. %s",
        order_id, intent["id"], reason,
    )


def run():
    orphans = 0
    for intent in recent_intents(LOOKBACK_DAYS):
        order_id = intent.metadata["order_id"]
        order = get_order(order_id)
        action, reason = decide(order, intent)
        if action != "orphan":
            continue
        log.info("Order %s: %s. %s", order_id, reason, "would report" if DRY_RUN else "reporting")
        report_orphan(order_id, intent, reason)
        orphans += 1
    log.info("Done. %d orphan candidate(s) found.", orphans)


if __name__ == "__main__":
    run()
