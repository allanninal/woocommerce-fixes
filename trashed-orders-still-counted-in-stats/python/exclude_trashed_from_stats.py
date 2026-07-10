"""Exclude trashed WooCommerce orders that are still counted in Analytics.

WooCommerce Analytics reads its totals from a lookup table (wc_order_stats), not
straight from the order list. An order is only pulled out of that table when the
normal "move to Trash" action fires and WooCommerce sets its own `_exclude_from_stats`
meta. A direct database delete, a cleanup cron, or a plugin that trashes orders by
writing the status column directly can skip that step, so a trashed order keeps
contributing to revenue and order count totals. This walks orders with status
`trash`, cross-checks the Stripe PaymentIntent as a safety net so a good order is
never silently hidden, and repairs the ones that should be excluded by setting
`_exclude_from_stats` to `yes`. Safe by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("exclude_trashed_from_stats")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EXCLUDE_META_KEY = "_exclude_from_stats"


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def is_excluded(order):
    for meta in order.get("meta_data") or []:
        if meta.get("key") == EXCLUDE_META_KEY:
            return str(meta.get("value")) in ("yes", "1", "true")
    return False


def decide(order, intent):
    """Pure decision function. No I/O. Returns (action, reason).

    action is one of: "skip", "repair", "hold".
    - skip: nothing to do, order is not trashed or is already excluded.
    - repair: trashed and not excluded, and Stripe agrees there is nothing live
      to protect (no succeeded charge, or the charge was refunded), so it is
      safe to mark it excluded from stats.
    - hold: trashed and not excluded, but Stripe still shows a succeeded,
      unrefunded charge. Do not silently hide real revenue. Flag for a human.
    """
    if order.get("status") != "trash":
        return ("skip", "order is not in trash")
    if is_excluded(order):
        return ("skip", "already excluded from stats")
    if intent is None:
        return ("repair", "trashed with no Stripe charge on record")
    if intent.get("status") != "succeeded":
        return ("repair", "trashed and Stripe charge did not succeed")
    if intent.get("amount_refunded", 0) >= intent.get("amount_received", 0) and intent.get("amount_received", 0) > 0:
        return ("repair", "trashed and the Stripe charge was fully refunded")
    return ("hold", "trashed but Stripe still shows a live, unrefunded charge")


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def trashed_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "trash", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def exclude_from_stats(order):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"meta_data": [{"key": EXCLUDE_META_KEY, "value": "yes"}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": "Excluded from Analytics: order is trashed and Stripe confirms "
                      "there is no live, unrefunded charge behind it. Set by the "
                      "trashed-orders-still-counted-in-stats script."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def flag_for_review(order, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Stats check held: {reason}. This order is trashed but Stripe "
                      f"still shows a real, unrefunded charge. Not excluding it "
                      f"automatically. Please review before it is deleted for good."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    repaired = 0
    held = 0
    for order in trashed_orders():
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent)
        if action == "skip":
            continue
        if action == "hold":
            log.warning("Order %s held: %s", order["id"], reason)
            if not DRY_RUN:
                flag_for_review(order, reason)
            held += 1
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would exclude" if DRY_RUN else "excluding")
        if not DRY_RUN:
            exclude_from_stats(order)
        repaired += 1
    log.info("Done. %d order(s) %s, %d held for review.",
              repaired, "to exclude" if DRY_RUN else "excluded", held)


if __name__ == "__main__":
    run()
