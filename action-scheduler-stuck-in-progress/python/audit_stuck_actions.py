"""Find Action Scheduler actions stuck on in-progress and decide how to clear them.

An action normally moves from pending, to in-progress, to complete within seconds.
When the PHP worker that claimed an action dies mid run (a timeout, an out of memory
kill, a fatal error), the action is left on in-progress forever. Action Scheduler's
own claim lock then treats that slot as busy, so the next run of that group or hook
can stall behind it, and the queue backs up.

This script does not touch wp_actionscheduler_actions directly. It uses the
WooCommerce REST API to read the order that a stuck subscription renewal or payment
action points to (order id is taken from the action's hook args, passed in on the
command line or from a small JSON export), asks Stripe for the truth about the
PaymentIntent on that order, and decides one of four outcomes:

  - "complete_order": Stripe says the payment succeeded. Mark the order processing
    and add a note. The stuck action can be marked complete in wp-admin or with
    `wp action-scheduler action update --id=<id> --status=complete`.
  - "reset_action": Stripe never took a real payment for this attempt (no intent,
    or the intent failed or is still requiring action). Safe to reset the action
    back to pending so it can be retried, since nothing was charged.
  - "wait": the action has not been stuck long enough yet to act on. Actions can
    briefly sit on in-progress during a normal, slow run.
  - "investigate": Stripe shows a PaymentIntent that requires_action or is
    processing. Money is in flight. Do not touch the order or the action yet.

Read only by default (DRY_RUN=true). Run on a schedule, for example every 15
minutes, well past STUCK_AFTER_MINUTES.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_stuck_actions")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
STUCK_AFTER_MINUTES = int(os.environ.get("STUCK_AFTER_MINUTES", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}
IN_FLIGHT_INTENT_STATUSES = {"requires_action", "requires_confirmation", "processing"}
FAILED_INTENT_STATUSES = {"requires_payment_method", "canceled"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(action, order, intent):
    """Pure decision function. No I/O. action is a dict with at least
    status and age_minutes. order and intent may be None.
    Returns (verdict, reason).
    """
    if action.get("status") != "in-progress":
        return ("skip", "action is not in-progress")
    if action.get("age_minutes", 0) < STUCK_AFTER_MINUTES:
        return ("wait", "action has not been stuck long enough yet")
    if order is None:
        return ("investigate", "action points to an order that cannot be found")
    if intent is not None and intent.get("status") in IN_FLIGHT_INTENT_STATUSES:
        return ("investigate", "Stripe shows the payment still in flight")
    if order.get("status") in PAID_STATUSES:
        return ("reset_action", "order is already paid, the action is just stale")
    if intent is not None and intent.get("status") == "succeeded":
        return ("complete_order", "Stripe succeeded but the order was never updated")
    if intent is None or intent.get("status") in FAILED_INTENT_STATUSES:
        return ("reset_action", "no successful charge behind this attempt, safe to retry")
    return ("investigate", "unclear Stripe state, needs a human look")


def get_order(order_id):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def complete_order(order_id, intent):
    charge_id = intent.get("latest_charge") or intent["id"]
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"status": "processing", "transaction_id": charge_id},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Recovered from a stuck Action Scheduler action. Stripe PaymentIntent "
                      f"{intent['id']} had already succeeded. Marked processing by the auditor."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def note_stuck_action(order_id, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Action Scheduler action for this order was stuck on in-progress: "
                      f"{reason}. Flagged for a reset by the auditor."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def stuck_actions_from_export(path):
    """Read a small JSON export of stuck actions. Each row looks like:
    {"action_id": 4821, "status": "in-progress", "age_minutes": 55, "order_id": 9321}
    Produce this with:
    wp action-scheduler action list --status=in-progress --format=json > stuck.json
    then add age_minutes and order_id per hook args before feeding it in, or adapt
    this loader to your own store's export shape.
    """
    import json
    with open(path) as f:
        return json.load(f)


def run(export_path):
    handled = 0
    for action in stuck_actions_from_export(export_path):
        order_id = action.get("order_id")
        order = get_order(order_id) if order_id else None
        intent = get_intent(intent_id_of(order)) if order else None
        verdict, reason = decide(action, order, intent)
        if verdict in ("skip", "wait"):
            continue
        log.info(
            "Action %s (order %s): %s -> %s",
            action.get("action_id"), order_id, reason,
            "would act" if DRY_RUN else "acting",
        )
        if not DRY_RUN:
            if verdict == "complete_order":
                complete_order(order_id, intent)
            elif verdict in ("reset_action", "investigate"):
                note_stuck_action(order_id, reason)
        handled += 1
    log.info("Done. %d stuck action(s) %s.", handled, "to handle" if DRY_RUN else "handled")


if __name__ == "__main__":
    import sys
    run(sys.argv[1] if len(sys.argv) > 1 else "stuck.json")
