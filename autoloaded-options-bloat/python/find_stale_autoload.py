"""Find stale, oversized autoloaded wp_options rows left behind by Stripe order
processing, and report which ones are safe to demote to autoload='no'.

WooCommerce Stripe gateways write small per-order records while a payment is in
flight: an idempotency lock, a processing flag, a cached PaymentIntent snapshot.
Some of these are saved with autoload left at the default of "yes", so every single
page load, including the storefront, pulls them into the alloptions cache. Once the
order is finished they serve no purpose, but nothing ever cleans them up, so the
autoloaded payload only grows.

This script reads a custom, read-only endpoint you add to your store
(wp-json/wc-tools/v1/autoloaded-options) that lists autoloaded options above a size
threshold, matches the Stripe-related ones back to their order through the order id
encoded in the option name, checks the order and its Stripe PaymentIntent are both
finished, and reports (or repairs) the ones safe to demote. Read only by default.
"""
import os
import re
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_stale_autoload")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
MIN_BYTES = int(os.environ.get("MIN_BYTES", "10000"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Matches option names such as _wc_stripe_idempotency_1042 or
# _wc_stripe_intent_1042, where the trailing digits are the WooCommerce order id.
ORDER_OPTION_RE = re.compile(r"^_wc_stripe_(?:idempotency|intent|lock)_(\d+)$")

FINISHED_ORDER_STATUSES = {"processing", "completed", "refunded", "cancelled", "failed"}
FINISHED_INTENT_STATUSES = {"succeeded", "canceled"}


def order_id_from_option(option_name):
    """Pull the WooCommerce order id out of a Stripe-related option name, or None."""
    match = ORDER_OPTION_RE.match(option_name)
    return int(match.group(1)) if match else None


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in (order or {}).get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = (order or {}).get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(option, order, intent):
    """Pure decision: what to do with one autoloaded option row.

    option is a dict with at least "option_name" and "bytes".
    order is the matching WooCommerce order dict, or None if not found.
    intent is the matching Stripe PaymentIntent dict, or None if not found.

    Returns a (action, reason) tuple. action is one of:
      "skip"   - leave it alone, not ours or below the size threshold
      "keep"   - it is ours, but the order or intent is still active
      "orphan" - it is ours, but the order no longer exists
      "demote" - it is ours, the order and the intent are both finished
    """
    if option.get("bytes", 0) < MIN_BYTES:
        return ("skip", "below the size threshold")
    order_id = order_id_from_option(option["option_name"])
    if order_id is None:
        return ("skip", "not a Stripe order option")
    if order is None:
        return ("orphan", f"order {order_id} no longer exists")
    if order["status"] not in FINISHED_ORDER_STATUSES:
        return ("keep", "order is still active")
    if intent is not None and intent.get("status") not in FINISHED_INTENT_STATUSES:
        return ("keep", "Stripe PaymentIntent is still active")
    return ("demote", "order and PaymentIntent are both finished")


def autoloaded_options(min_bytes):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc-tools/v1/autoloaded-options",
        params={"min_bytes": min_bytes},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return r.json()


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


def demote(option_name):
    requests.post(
        f"{WOO_URL}/wp-json/wc-tools/v1/autoloaded-options/demote",
        json={"option_name": option_name},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    demoted = 0
    total_bytes = 0
    for option in autoloaded_options(MIN_BYTES):
        order_id = order_id_from_option(option["option_name"])
        order = get_order(order_id) if order_id is not None else None
        intent = get_intent(intent_id_of(order)) if order else None
        action, reason = decide(option, order, intent)
        if action in ("skip", "keep"):
            continue
        if action == "orphan":
            log.warning("%s: %s", option["option_name"], reason)
        log.info(
            "%s (%d bytes): %s. %s",
            option["option_name"], option.get("bytes", 0), reason,
            "would demote" if DRY_RUN else "demoting",
        )
        if not DRY_RUN:
            demote(option["option_name"])
        demoted += 1
        total_bytes += option.get("bytes", 0)
    log.info(
        "Done. %d option(s) %s, freeing about %d KB from every page load.",
        demoted, "to demote" if DRY_RUN else "demoted", round(total_bytes / 1024),
    )


if __name__ == "__main__":
    run()
