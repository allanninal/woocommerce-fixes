"""Repair orders whose Stripe status went stale after the Clear Transients tool ran.

WooCommerce Status, Tools, Clear transients deletes the wp_options rows for
`_transient_wc_*` and their `_transient_timeout_wc_*` partners. The tool matches both
names with one LIKE query, but WordPress writes the timeout row and the value row as
two separate INSERTs. If a request is killed between them (a timeout, a memory limit,
a second click on the same button), one row survives without its partner. That
surviving row is residue: WooCommerce's own transient get/set calls skip a row with no
timeout, so the cache never refreshes itself and quietly goes stale forever.

The customer facing version of this is a PaymentIntent status cached in order meta
that stops following the intent once its backing transient is half deleted. This walks
recent orders, reads the saved PaymentIntent id, and flags (or repairs) any order whose
cached status disagrees with what Stripe reports right now. Safe by default. Run on a
schedule after anyone runs the clear transients tool, or as a weekly check.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_transient_residue")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Order statuses where the cached payment state actually matters.
LIVE_STATUSES = {"pending", "on-hold", "processing", "completed"}

# What each Woo order status implies the cached payment state should be.
PAID_STATUSES = {"processing", "completed"}
UNPAID_STATUSES = {"pending", "on-hold"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(order["total"]) * 100)


def decide(order, intent):
    """Pure decision function. No network calls, no side effects.

    Returns a tuple of (action, reason). action is one of:
      skip    - nothing to check, or already agrees with Stripe
      orphan  - the order has no PaymentIntent id to check against
      repair  - the order status disagrees with what Stripe reports now
    """
    if order["status"] not in LIVE_STATUSES:
        return ("skip", "order status is not one the cache tracks")
    if intent is None:
        return ("orphan", "no PaymentIntent id saved on the order")
    if intent.get("status") == "succeeded":
        if order["status"] in UNPAID_STATUSES:
            if abs(order_amount_minor(order) - intent.get("amount_received", 0)) > 1:
                return ("skip", "amount does not match, needs a human look")
            return ("repair", "Stripe succeeded but the stale cache left the order unpaid")
        return ("skip", "already matches a succeeded charge")
    if intent.get("status") in ("canceled", "requires_payment_method"):
        if order["status"] in PAID_STATUSES:
            return ("repair", "order is marked paid but the stale cache missed a failure or cancellation")
        return ("skip", "both sides agree the payment did not complete")
    return ("skip", "intent is still in progress, nothing stale to repair yet")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def recent_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def repair(order, intent, reason):
    new_status = "processing" if intent.get("status") == "succeeded" else "on-hold"
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"status": new_status},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Transient residue repair: {reason}. Stripe PaymentIntent "
                      f"{intent['id']} now reports {intent.get('status')}. Order moved "
                      f"to {new_status} to match. A stale cache row left behind by the "
                      f"Clear transients tool likely hid this."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    orphans = 0
    for order in recent_orders():
        intent_id = intent_id_of(order)
        intent = get_intent(intent_id)
        action, reason = decide(order, intent)
        if action == "orphan":
            orphans += 1
            log.warning("Order %s: %s", order["id"], reason)
            continue
        if action == "skip":
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would repair" if DRY_RUN else "repairing")
        if not DRY_RUN:
            repair(order, intent, reason)
        fixed += 1
    log.info("Done. %d order(s) %s, %d orphan(s) with no PaymentIntent id.",
              fixed, "to repair" if DRY_RUN else "repaired", orphans)


if __name__ == "__main__":
    run()
