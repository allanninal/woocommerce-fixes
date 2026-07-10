"""Record Stripe disputes and chargebacks on the matching WooCommerce order.

A chargeback pulls funds out of your Stripe balance the moment the bank files it,
but nothing about that event reaches WooCommerce on its own unless the
charge.dispute.* webhooks are wired up and processed. When they are missed, the
order still shows its normal paid total, the shop manager has no idea money left
the account, and the evidence deadline can pass unnoticed. This walks recent
disputes from Stripe, finds the order that was charged, and writes the dispute
status, amount, and evidence deadline onto the order as a note (and an order
meta field), so the loss and the deadline are visible where the shop manager
already works. Read only by default. Run on a schedule.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("record_disputes")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "72"))
HOLD_ON_OPEN_DISPUTE = os.environ.get("HOLD_ON_OPEN_DISPUTE", "false").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Statuses where the case is still open and needs evidence or a decision.
OPEN_STATUSES = {
    "warning_needs_response",
    "warning_under_review",
    "needs_response",
    "under_review",
}
# Statuses where Stripe has finished the case.
CLOSED_STATUSES = {"won", "lost", "warning_closed", "charge_refunded"}

DISPUTE_META_KEY = "_dispute_status"


def recent_disputes(lookback_hours):
    """Yield Stripe disputes created within the lookback window, oldest fields expanded."""
    since = int(time.time()) - lookback_hours * 3600
    disputes = stripe.Dispute.list(limit=100, created={"gte": since})
    for dispute in disputes.auto_paging_iter():
        yield dispute


def intent_id_of_dispute(dispute):
    """The PaymentIntent id behind a dispute, straight from the charge it disputes."""
    charge = dispute.get("charge")
    if isinstance(charge, dict):
        return charge.get("payment_intent")
    # Some API versions return the charge as an id string. Retrieve it to get
    # the PaymentIntent id. This is the one network call we cannot avoid.
    if isinstance(charge, str):
        try:
            full_charge = stripe.Charge.retrieve(charge)
            return full_charge.get("payment_intent")
        except stripe.error.InvalidRequestError:
            return None
    return None


def find_order_by_intent(intent_id):
    """Look up the order whose saved PaymentIntent id matches, via the WooCommerce
    REST API search on meta. Falls back to a direct meta query."""
    if not intent_id:
        return None
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"meta_key": "_stripe_intent_id", "meta_value": intent_id, "per_page": 1},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    batch = r.json()
    if batch:
        return batch[0]
    # Fall back to transaction_id, which some setups use instead of order meta.
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"search": intent_id, "per_page": 5},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    for order in r.json():
        if order.get("transaction_id") == intent_id:
            return order
    return None


def order_dispute_meta(order):
    """The dispute status already recorded on the order, or None if never recorded."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == DISPUTE_META_KEY:
            return meta.get("value") or None
    return None


def decide(order, dispute):
    """Pure decision function: no I/O, just data in, action out.

    Returns a tuple of (action, reason). action is one of:
      "orphan"  - the dispute has no matching order, worth a manual look
      "skip"    - the order already has this exact dispute status recorded
      "record"  - write the dispute status onto the order
    """
    if order is None:
        return ("orphan", "no order matches this dispute's PaymentIntent")
    recorded = order_dispute_meta(order)
    if recorded == dispute["status"]:
        return ("skip", "order already shows this dispute status")
    return ("record", "dispute status changed or was never recorded")


def dispute_amount_minor(dispute):
    """Stripe already reports dispute amounts in minor units (cents), unlike the
    WooCommerce order total, so no conversion is needed here."""
    return int(dispute["amount"])


def format_note(dispute, reason):
    amount = dispute_amount_minor(dispute) / 100
    currency = dispute.get("currency", "usd").upper()
    deadline = dispute.get("evidence_details", {}).get("due_by")
    deadline_str = (
        time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(deadline)) if deadline else "no deadline given"
    )
    return (
        f"Stripe dispute {dispute['id']} is {dispute['status']} for {amount:.2f} {currency}. "
        f"Reason: {dispute.get('reason', 'unknown')}. Evidence due by {deadline_str}. "
        f"({reason})"
    )


def record(order, dispute):
    note = format_note(dispute, "recorded by the disputes reconciler")
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": note},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"meta_data": [{"key": DISPUTE_META_KEY, "value": dispute["status"]}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    if HOLD_ON_OPEN_DISPUTE and dispute["status"] in OPEN_STATUSES and order["status"] not in ("on-hold", "refunded", "cancelled"):
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
            json={"status": "on-hold"},
            auth=AUTH, timeout=30,
        ).raise_for_status()


def run():
    recorded = 0
    for dispute in recent_disputes(LOOKBACK_HOURS):
        intent_id = intent_id_of_dispute(dispute)
        order = find_order_by_intent(intent_id)
        action, reason = decide(order, dispute)
        if action == "orphan":
            log.warning("Dispute %s (intent %s): %s", dispute["id"], intent_id, reason)
            continue
        if action == "skip":
            continue
        log.info(
            "Dispute %s on order %s: %s. %s",
            dispute["id"], order["id"], reason, "would record" if DRY_RUN else "recording",
        )
        if not DRY_RUN:
            record(order, dispute)
        recorded += 1
    log.info("Done. %d dispute(s) %s.", recorded, "to record" if DRY_RUN else "recorded")


if __name__ == "__main__":
    run()
