"""Detect WooCommerce orders that failed, or are about to fail, because their
currency is not enabled on the connected Stripe account.

Stripe accounts only accept a fixed list of settlement currencies. If a store adds
a new store currency, a multi-currency plugin, or a manual order in a currency the
Stripe account was never approved for, the charge fails with an error such as
"currency_not_enabled" or "moto_not_supported" (or amount_too_small/large depending
on the mismatched minor unit). This script lists the account's enabled currencies
once, then walks recent orders and flags any whose currency Stripe will reject or
already rejected, before the shopper hits a confusing decline. Read only by
default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_currency_not_enabled")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "3"))
REVIEW_HOLD = os.environ.get("REVIEW_HOLD", "false").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Orders worth checking: still open (pending, on-hold) or already failed.
CHECKABLE_STATUSES = {"pending", "on-hold", "failed"}

# Stripe error codes that mean the currency itself is the problem, not the card.
CURRENCY_ERROR_CODES = {"currency_not_enabled", "moto_not_supported"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_currency(order):
    """WooCommerce order currency, lower cased to match Stripe's format."""
    return (order.get("currency") or "").lower()


def decide(order, enabled_currencies, intent=None):
    """Pure decision function. No I/O.

    order: dict with at least "status" and "currency".
    enabled_currencies: set/list of lower case currency codes the Stripe account accepts.
    intent: optional Stripe PaymentIntent dict (or None if none was ever created).

    Returns a tuple of (action, reason).
    action is one of "skip", "flag", "already_flagged".
    """
    if order["status"] not in CHECKABLE_STATUSES:
        return ("skip", "order is not pending, on-hold, or failed")

    currency = order_currency(order)
    if not currency:
        return ("skip", "order has no currency set")

    enabled = {c.lower() for c in enabled_currencies}
    currency_supported = currency in enabled

    last_error_code = None
    if intent is not None:
        last_error = intent.get("last_payment_error") or {}
        last_error_code = last_error.get("code")

    if not currency_supported:
        return ("flag", f"currency {currency} is not enabled on the Stripe account")

    if last_error_code in CURRENCY_ERROR_CODES:
        return ("flag", f"Stripe rejected the charge with {last_error_code}")

    return ("skip", "currency is enabled and no currency related error was found")


def get_enabled_currencies():
    """The settlement currencies the connected Stripe account can charge in.

    Stripe's capabilities are not currency specific, so the reliable source is the
    country spec for the account's country, which lists every currency that country
    is allowed to accept payments in.
    """
    account = stripe.Account.retrieve()
    country = account.get("country", "US")
    spec = stripe.CountrySpec.retrieve(country)
    supported = spec.get("supported_payment_currencies") or []
    return {c.lower() for c in supported}


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def checkable_orders():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={
                "status": "pending,on-hold,failed",
                "per_page": 50,
                "page": page,
            },
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def flag(order, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Payment check failed: {reason}. Enable this currency in the Stripe "
                      f"Dashboard under Settings, Payment methods, or refund and rebill the "
                      f"buyer in a supported currency. Please review."},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    if REVIEW_HOLD and order["status"] != "on-hold":
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
            json={"status": "on-hold"}, auth=AUTH, timeout=30,
        ).raise_for_status()


def run():
    enabled_currencies = get_enabled_currencies()
    log.info("Stripe account accepts: %s", ", ".join(sorted(enabled_currencies)) or "(none found)")
    flagged = 0
    for order in checkable_orders():
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, enabled_currencies, intent)
        if action != "flag":
            continue
        log.warning("Order %s: %s. %s", order["id"], reason, "would flag" if DRY_RUN else "flagging")
        if not DRY_RUN:
            flag(order, reason)
        flagged += 1
    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
