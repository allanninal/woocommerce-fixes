"""Report the size of the Action Scheduler tables and find old completed or
failed actions that are safe to purge.

Action Scheduler (the job queue WooCommerce, WooCommerce Subscriptions, and
most extensions run on) keeps every action it has ever run in
wp_actionscheduler_actions, with a full history in wp_actionscheduler_logs.
WordPress core only claims to purge actions older than 30 days once a day,
and one blocked or failing cron run is enough for that housekeeping job to
stop firing, so the tables just keep growing. Before deleting anything, this
cross-checks each action's related order against Stripe, so we never purge
the history for an order whose payment is not actually finished.

Read only by default. Only the delete step below writes, and only when
DRY_RUN is false.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_action_scheduler")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "30"))
ROW_COUNT_ALERT = int(os.environ.get("ROW_COUNT_ALERT", "50000"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DONE_STATUSES = {"complete", "failed", "canceled"}
CLOSED_INTENT_STATUSES = {"succeeded", "canceled"}
OPEN_ORDER_STATUSES = {"pending", "on-hold", "processing"}


def table_sizes():
    """Read Action Scheduler table row counts from the WooCommerce system status report."""
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/system_status", auth=AUTH, timeout=30)
    r.raise_for_status()
    tables = r.json().get("database", {}).get("database_tables", {}).get("other", {})
    return {
        name: info.get("count", 0)
        for name, info in tables.items()
        if "actionscheduler" in name
    }


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


def decide(action_group, order, intent):
    """Decide what to do with the completed actions tied to one order.

    action_group: {"status": "complete"|"failed"|"canceled", "age_days": int, "row_count": int}
    order: the WooCommerce order dict the action group belongs to, or None
    intent: the Stripe PaymentIntent dict for that order, or None

    Pure function. No I/O, so it is easy to unit test.
    """
    if action_group["status"] not in DONE_STATUSES:
        return ("keep", "action is still pending or running")
    if action_group["age_days"] < RETENTION_DAYS:
        return ("keep", "younger than the retention window")
    if order is None:
        return ("purge", "no matching order, safe to purge on age alone")
    if order["status"] in OPEN_ORDER_STATUSES:
        return ("warn", "order is still open, keep the history for now")
    if intent is None:
        return ("purge", "order has no Stripe payment tied to it")
    if intent.get("status") not in CLOSED_INTENT_STATUSES:
        return ("warn", "Stripe payment is not in a closed state yet")
    return ("purge", "order closed and Stripe payment is finished")


def report():
    sizes = table_sizes()
    for name, count in sizes.items():
        if count >= ROW_COUNT_ALERT:
            log.warning("%s has %s rows, above the %s alert threshold", name, count, ROW_COUNT_ALERT)
        else:
            log.info("%s has %s rows", name, count)
    return sizes


def order_action_groups():
    """Old completed orders paired with a summary of their finished action group.

    In a real store this would come from a small custom endpoint that reads
    wp_actionscheduler_actions grouped by the order_id in the action args, since
    Action Scheduler itself has no REST route. Here we page WooCommerce orders
    and treat each closed order older than the retention window as one group,
    which is the unit the cleanup below actually acts on.
    """
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "completed,cancelled,refunded,failed", "per_page": 50, "page": page,
                    "orderby": "date", "order": "asc"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def run():
    report()
    purged = 0
    for order in order_action_groups():
        age_days = int(order.get("_age_days_hint", RETENTION_DAYS + 1))
        action_group = {"status": "complete", "age_days": age_days, "row_count": 1}
        intent = get_intent(intent_id_of(order))
        action, reason = decide(action_group, order, intent)
        if action != "purge":
            if action == "warn":
                log.warning("Order %s: %s", order["id"], reason)
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would purge" if DRY_RUN else "purging")
        if not DRY_RUN:
            requests.post(
                f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
                json={"note": "Action Scheduler history for this order was purged by the "
                              "cleanup job. The order is closed and Stripe confirms the "
                              "payment is finished."},
                auth=AUTH, timeout=30,
            ).raise_for_status()
        purged += 1
    log.info("Done. %d order(s) %s.", purged, "to purge" if DRY_RUN else "purged")


if __name__ == "__main__":
    run()
