"""Clear the WooCommerce Stripe checkout locks that are left behind as expired
transients in wp_options.

Every time a shopper starts paying, the WooCommerce Stripe gateway writes a short
lived transient such as `_transient_wc_stripe_lock_pi_...` (plus its matching
`_transient_timeout_wc_stripe_lock_pi_...` row) to stop the same PaymentIntent from
being processed twice at once. The lock is supposed to delete itself, or expire and
get swept the next time WordPress asks for that exact key. In practice checkout is
interrupted a lot: a fatal error mid request, a webhook that times out, a customer
who closes the tab. Nothing ever asks for that one off key again, so the row just
sits in wp_options, almost always with `autoload=yes`, forever. On a busy store this
turns into tens of thousands of dead rows that WordPress loads into memory on
every single page view.

We cannot run raw SQL against wp_options from a script that only has WooCommerce
REST API and Stripe API access, so this script does the next safest thing: it walks
orders whose PaymentIntent is done on Stripe (succeeded or canceled) but which still
carry the store's own `_stripe_checkout_lock` order meta flag, the same marker the
gateway used to guard against a double charge. If Stripe has already settled the
intent, that lock has no reason to still exist, so we clear the order meta and log
the matching transient key for the site's cleanup job (or wp cli) to sweep out of
wp_options in bulk. Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_stale_checkout_locks")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Stripe PaymentIntent statuses that mean the intent is fully done, so any lock that
# was guarding it can never be needed again.
SETTLED_INTENT_STATUSES = {"succeeded", "canceled"}
LOCK_META_KEY = "_stripe_checkout_lock"


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def lock_value_of(order):
    """The stored lock marker for this order, or None if it was never set or already cleared."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == LOCK_META_KEY and meta.get("value"):
            return meta["value"]
    return None


def transient_key_for(intent_id):
    """The wp_options key this lock corresponds to, for the site's own cleanup tooling."""
    return f"_transient_wc_stripe_lock_{intent_id}"


def decide(order, intent):
    """Pure decision. No I/O. Returns (action, reason).

    order: the WooCommerce order dict from the REST API.
    intent: the Stripe PaymentIntent dict for this order's saved id, or None if Stripe
        has no record of it (a bad id, a test/live key mismatch, or it was never created).
    """
    lock = lock_value_of(order) if order is not None else None
    if not lock:
        return ("skip", "no checkout lock on this order, nothing to clear")
    if intent is None:
        return ("skip", "no matching Stripe PaymentIntent, leave the lock alone")
    if intent.get("status") not in SETTLED_INTENT_STATUSES:
        return ("skip", "PaymentIntent is still in progress, the lock may still be needed")
    return ("clear", f"PaymentIntent is {intent['status']}, the lock is stale")


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


def clear_lock(order):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"meta_data": [{"key": LOCK_META_KEY, "value": ""}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": "Cleared a stale Stripe checkout lock left over from a finished "
                      "payment. The matching wp_options transient can now be purged."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    cleared = 0
    for order in recent_orders():
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent)
        if action != "clear":
            continue
        key = transient_key_for(intent_id_of(order))
        log.info("Order %s: %s. transient key %s. %s", order["id"], reason, key,
                  "would clear" if DRY_RUN else "clearing")
        if not DRY_RUN:
            clear_lock(order)
        cleared += 1
    log.info("Done. %d order(s) %s.", cleared, "to clear" if DRY_RUN else "cleared")


if __name__ == "__main__":
    run()
