"""Stop a Stripe webhook event from being applied to a WooCommerce order twice.

Stripe retries a webhook delivery whenever it does not get a fast 2xx response,
and the same event id can also be redelivered after a Stripe dashboard resend or
a queue replay. If the handler is not idempotent, the same event.id ends up
applying its note, stock change, or email a second (or third) time on the order.

This keeps a small ledger of event ids already applied to each order, read from
and written to the order's own meta data (no separate database needed). Before
doing any work for an incoming event, it checks the ledger. Read only by
default. Run this as the body of your webhook handler, or replay it against
recent events on a schedule to catch anything the live handler missed.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dedupe_webhook_events")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

LEDGER_META_KEY = "_processed_webhook_event_ids"
MAX_LEDGER_SIZE = 50
APPLIED_EVENT_TYPES = {"payment_intent.succeeded", "charge.succeeded"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def ledger_of(order):
    """The list of Stripe event ids already applied to this order."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == LEDGER_META_KEY and isinstance(meta.get("value"), list):
            return list(meta["value"])
    return []


def decide(order, event, ledger):
    """Pure decision: should this webhook event be applied to this order?

    order   -- the WooCommerce order dict (or None if it could not be found)
    event   -- a dict with at least "id" and "type" from Stripe
    ledger  -- the list of event ids already recorded as applied to this order

    Returns a tuple of (action, reason). action is one of:
      "apply"  -- event is new for this order, go ahead and act on it
      "skip"   -- event id is already in the ledger, do nothing
      "ignore" -- event type is not one this handler acts on
      "orphan" -- order could not be found for this event
    """
    if event.get("type") not in APPLIED_EVENT_TYPES:
        return ("ignore", "event type is not handled here")
    if order is None:
        return ("orphan", "order not found for this event")
    if event.get("id") in ledger:
        return ("skip", "event id already applied to this order")
    return ("apply", "new event for this order")


def next_ledger(ledger, event_id):
    """Pure helper: the ledger after recording event_id, capped to MAX_LEDGER_SIZE."""
    updated = ledger + [event_id]
    return updated[-MAX_LEDGER_SIZE:]


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def recent_events(lookback_hours):
    since = int(time.time()) - lookback_hours * 3600
    for event in stripe.Event.list(
        limit=100,
        created={"gte": since},
        types=list(APPLIED_EVENT_TYPES),
    ).auto_paging_iter():
        yield event


def order_id_of_event(event):
    intent = event.get("data", {}).get("object", {}) or {}
    return intent.get("metadata", {}).get("order_id")


def apply_event(order, event):
    """Do the work a webhook would do, then record the event id in the ledger."""
    order_id = order["id"]
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Stripe event {event['id']} ({event['type']}) applied. "
                      f"Recorded in the webhook event ledger so a retry cannot double it up."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    ledger = next_ledger(ledger_of(order), event["id"])
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"meta_data": [{"key": LEDGER_META_KEY, "value": ledger}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    applied = 0
    skipped = 0
    for event in recent_events(LOOKBACK_HOURS):
        order_id = order_id_of_event(event)
        order = get_order(order_id) if order_id else None
        ledger = ledger_of(order) if order else []
        action, reason = decide(order, event, ledger)
        if action == "orphan":
            log.warning("Event %s points to order %s which is missing", event["id"], order_id)
            continue
        if action == "ignore":
            continue
        if action == "skip":
            log.info("Event %s: %s", event["id"], reason)
            skipped += 1
            continue
        log.info("Event %s on order %s: %s. %s", event["id"], order_id, reason,
                  "would apply" if DRY_RUN else "applying")
        if not DRY_RUN:
            apply_event(order, event)
        applied += 1
    log.info("Done. %d event(s) %s, %d duplicate(s) skipped.",
              applied, "to apply" if DRY_RUN else "applied", skipped)


if __name__ == "__main__":
    run()
