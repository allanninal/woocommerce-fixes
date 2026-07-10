"""Detect WooCommerce orders whose total is off by a cent (or two) from what
Stripe actually charged.

WooCommerce can round each line item's tax separately while Stripe (or the
card network) rounds the grand total once, so the two systems land on
different final digits even though nothing is actually wrong with the sale.
This walks recent paid orders, reads the saved Stripe PaymentIntent, compares
the amounts in minor units (cents), and flags any order where the drift is
larger than one cent (a real mismatch) or, optionally, notes the ones off by
exactly one or two cents so accounting can reconcile them. Read only by
default. Run on a schedule.
"""
import os
import datetime
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_rounding_drift")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
# A drift of 1 cent is the classic rounding case. Anything larger is a real
# mismatch worth a louder flag (wrong currency conversion, a fee that was not
# saved, a manually edited order, and so on).
ROUNDING_TOLERANCE_CENTS = int(os.environ.get("ROUNDING_TOLERANCE_CENTS", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_total_minor(order):
    """The order total in cents. Keep all money math in minor units so
    float rounding never sneaks a second bug into the comparison."""
    return round(float(order["total"]) * 100)


def decide(order, intent):
    """Pure decision: no network, no I/O. Given a WooCommerce order (dict)
    and its Stripe PaymentIntent (dict or None), return an (action, reason)
    tuple.

    Actions:
      skip     - order is not in a paid state, nothing to check yet.
      orphan   - order is paid but has no PaymentIntent id or Stripe cannot
                 find it, worth a look but not a rounding problem.
      drift    - the amounts differ by more than zero cents but no more than
                 ROUNDING_TOLERANCE_CENTS, the classic rounding case.
      mismatch - the amounts differ by more than the tolerance, a real
                 problem that is not just rounding.
      ok       - the amounts match exactly.
    """
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order not in a paid state")
    if intent is None:
        return ("orphan", "no Stripe PaymentIntent found for a paid order")
    if intent.get("status") != "succeeded":
        return ("orphan", "Stripe shows the payment not succeeded")

    charged = intent.get("amount_received")
    if charged is None:
        return ("orphan", "PaymentIntent has no amount_received")

    diff_cents = order_total_minor(order) - charged
    if diff_cents == 0:
        return ("ok", "order total matches the Stripe charge exactly")
    if abs(diff_cents) <= ROUNDING_TOLERANCE_CENTS:
        return ("drift", f"order total is {diff_cents:+d} cent(s) from the Stripe charge")
    return ("mismatch", f"order total is {diff_cents:+d} cent(s) from the Stripe charge, too large to be rounding")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def paid_orders():
    page = 1
    after = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat() + "T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "processing,completed", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def report(order, action, reason):
    note = (
        f"Rounding check: {reason}. Order total is {order['total']} {order.get('currency', '')}. "
        f"Flagged as {action} by the rounding drift detector."
    )
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": note},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    flagged = 0
    for order in paid_orders():
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent)
        if action in ("skip", "ok"):
            continue
        log.warning("Order %s: %s. %s", order["id"], reason, "would flag" if DRY_RUN else "flagging")
        if not DRY_RUN:
            report(order, action, reason)
        flagged += 1
    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
