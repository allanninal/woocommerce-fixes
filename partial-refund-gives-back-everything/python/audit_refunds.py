"""Catch WooCommerce partial refunds that actually returned the whole charge.

On an order whose PaymentIntent was captured for less than the order total
(a manual capture, a phone order finished outside checkout, a split payment),
WooCommerce computes "amount left to refund" from the order total instead of
the real Stripe amount_captured. Ask for a small partial refund and the
gateway can send Stripe a refund with no amount, or an amount larger than
what is actually left, so Stripe refunds the entire remaining balance.

This script compares, per order, the refund the shop manager intended
(the WooCommerce refund line item) against what Stripe actually refunded on
the matching charge. When Stripe refunded more than intended, it writes an
order note flagging the gap. It never asks Stripe to move money and never
edits amounts. It only reports. Read only by default. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/partial-refund-gives-back-everything/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_refunds")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_HOURS = int(os.environ.get("LOOKBACK_HOURS", "72"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Tolerance in cents for rounding noise between the two systems.
TOLERANCE_MINOR = 1


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and (tid.startswith("pi_") or tid.startswith("ch_")) else None


def recently_refunded_orders(lookback_hours):
    """WooCommerce orders that had a refund recorded in the lookback window."""
    since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - lookback_hours * 3600))
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "refunded,processing,completed", "after": since, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            if float(order.get("total_refunded") or 0) > 0:
                yield order
        page += 1


def woo_intended_refund_minor(order):
    """What the shop manager actually asked WooCommerce to refund, in cents."""
    return round(float(order.get("total_refunded") or 0) * 100)


def get_charge_for_intent(intent_id):
    """The Stripe Charge behind a PaymentIntent or charge id, or None if not found."""
    if not intent_id:
        return None
    try:
        if intent_id.startswith("ch_"):
            return stripe.Charge.retrieve(intent_id)
        intent = stripe.PaymentIntent.retrieve(intent_id, expand=["latest_charge"])
        return intent.get("latest_charge")
    except stripe.error.InvalidRequestError:
        return None


def stripe_refunded_minor(charge):
    """What Stripe actually returned to the card for this charge, in cents."""
    return int((charge or {}).get("amount_refunded") or 0)


def decide(order, charge, woo_intended_minor, stripe_refunded_minor_value):
    """Pure decision: compare the intended refund to what Stripe actually moved.

    order: dict with at least "id" and "status".
    charge: dict-like Stripe Charge, or None if it could not be found.
    woo_intended_minor: cents the WooCommerce refund record says was refunded.
    stripe_refunded_minor_value: cents Stripe's charge.amount_refunded reports.

    Returns (action, reason, over_refund_minor).
    """
    if charge is None:
        return ("orphan", "no matching Stripe charge for this order", 0)
    if woo_intended_minor <= 0:
        return ("skip", "no refund recorded on this order", 0)
    gap = stripe_refunded_minor_value - woo_intended_minor
    if gap > TOLERANCE_MINOR:
        return ("overrefund", "Stripe refunded more than WooCommerce intended", gap)
    if gap < -TOLERANCE_MINOR:
        return ("underrefund", "Stripe refunded less than WooCommerce intended", gap)
    return ("ok", "Stripe refund matches the intended amount", 0)


def flag(order, reason, over_refund_minor):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": (
            f"Refund check: {reason}. Stripe returned "
            f"{over_refund_minor / 100:.2f} more than the WooCommerce refund record shows. "
            f"This usually means the order's captured amount differs from Stripe's actual "
            f"amount_captured (a manual or partial capture). Review before refunding this "
            f"order again."
        )},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    flagged = 0
    for order in recently_refunded_orders(LOOKBACK_HOURS):
        intent_id = intent_id_of(order)
        charge = get_charge_for_intent(intent_id)
        woo_intended = woo_intended_refund_minor(order)
        stripe_refunded = stripe_refunded_minor(charge)
        action, reason, over_refund_minor = decide(order, charge, woo_intended, stripe_refunded)
        if action == "orphan":
            log.warning("Order %s has a refund but no matching Stripe charge (%s)", order["id"], intent_id)
            continue
        if action in ("skip", "ok", "underrefund"):
            continue
        log.warning(
            "Order %s: %s. Woo intended %sc, Stripe refunded %sc. %s",
            order["id"], reason, woo_intended, stripe_refunded,
            "would flag" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag(order, reason, over_refund_minor)
        flagged += 1
    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
