"""Detect a Stripe test/live key mixup on a WooCommerce store.

A store can end up calling Stripe with a secret key from the wrong mode: a
test key left behind after a launch, a live key pasted into a staging site,
or a key rotated in one place but not the other. When that happens, every
charge that touches an object created in the other mode fails, and Stripe's
own error message says exactly why: "a similar object exists in live mode
[or test mode], but a test mode key [or live mode key] was used to make this
request." This script reads the WooCommerce Stripe gateway settings, checks
whether the secret key we were given matches the store's configured mode,
and confirms the mismatch (or clears it) by asking Stripe about a recent
order's PaymentIntent. It never changes a key. It only reports what it finds
as an order note and a log line. Read only by default. Run on demand or on
a schedule.
"""
import os
import re
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_key_mixup")

STRIPE_SECRET_KEY = os.environ["STRIPE_SECRET_KEY"]
stripe.api_key = STRIPE_SECRET_KEY
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_ORDERS = int(os.environ.get("LOOKBACK_ORDERS", "20"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

MODE_MISMATCH_RE = re.compile(
    r"similar object exists in (live|test) mode", re.IGNORECASE
)


def key_mode(secret_key):
    """"test", "live", or "unknown" from a Stripe secret or restricted key prefix."""
    if not secret_key:
        return "unknown"
    if secret_key.startswith("sk_test_") or secret_key.startswith("rk_test_"):
        return "test"
    if secret_key.startswith("sk_live_") or secret_key.startswith("rk_live_"):
        return "live"
    return "unknown"


def gateway_test_mode(settings):
    """True if the WooCommerce Stripe gateway is set to test mode, from its settings dict."""
    value = (settings or {}).get("testmode", {}).get("value")
    return str(value).lower() == "yes"


def mode_mismatch_from_error(message):
    """Parse a Stripe InvalidRequestError message for the 'wrong mode key' signature.

    Returns the mode the object actually lives in ("live" or "test"), or None
    if the message is not that specific error.
    """
    if not message:
        return None
    match = MODE_MISMATCH_RE.search(message)
    return match.group(1).lower() if match else None


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(configured_key_mode, store_test_mode, probe_error_message=None):
    """Pure decision function. No I/O.

    configured_key_mode: "test" | "live" | "unknown", from key_mode() on our own key.
    store_test_mode: bool, from the WooCommerce Stripe gateway's testmode setting.
    probe_error_message: the Stripe error message from a live API call, if one was made,
                          else None when no probe was run or the probe succeeded.

    Returns (verdict, reason):
      "match"             configuration and probe agree, nothing to do
      "config_drift"      the gateway's declared mode disagrees with our key, before
                           even calling Stripe. Worth fixing even if no probe ran yet.
      "confirmed_mismatch" a live Stripe call proved objects belong to the other mode
      "inconclusive"       we do not have enough signal to say either way
    """
    expected_mode = "test" if store_test_mode else "live"

    if configured_key_mode == "unknown":
        return ("inconclusive", "could not read the configured key's mode")

    probed_mode = mode_mismatch_from_error(probe_error_message)
    if probed_mode is not None:
        return (
            "confirmed_mismatch",
            f"Stripe confirms the order's data lives in {probed_mode} mode, "
            f"but the configured key is a {configured_key_mode} mode key",
        )

    if configured_key_mode != expected_mode:
        return (
            "config_drift",
            f"WooCommerce is set to {expected_mode} mode but the configured "
            f"Stripe key is a {configured_key_mode} mode key",
        )

    return ("match", "configured key mode matches the store's declared mode")


def get_gateway_settings():
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/payment_gateways/stripe", auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json().get("settings", {})


def recent_orders(limit):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"per_page": limit, "orderby": "date", "order": "desc"},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def probe_intent(intent_id):
    """Try to read one PaymentIntent with the configured key. Returns the error
    message string on an InvalidRequestError, or None if it succeeded or there
    was nothing to probe."""
    if not intent_id:
        return None
    try:
        stripe.PaymentIntent.retrieve(intent_id)
        return None
    except stripe.error.InvalidRequestError as exc:
        return str(exc)


def note_order(order_id, reason):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={
            "note": f"Key mismatch check: {reason}. Verify the Stripe secret key "
                    f"configured for this store matches the mode (test or live) "
                    f"you intend to run in."
        },
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    settings = get_gateway_settings()
    store_test_mode = gateway_test_mode(settings)
    configured_mode = key_mode(STRIPE_SECRET_KEY)

    # Config-only check first. This alone catches most mixups with zero API risk.
    verdict, reason = decide(configured_mode, store_test_mode)
    if verdict == "config_drift":
        log.warning("Config drift found before any Stripe call: %s", reason)
    else:
        log.info("Config check: %s", reason)

    # Confirm (or clear) with a live probe against a recent real order, since the
    # gateway setting can itself be wrong or stale.
    checked = 0
    confirmed = 0
    for order in recent_orders(LOOKBACK_ORDERS):
        intent_id = intent_id_of(order)
        if not intent_id:
            continue
        checked += 1
        error_message = probe_intent(intent_id)
        probe_verdict, probe_reason = decide(configured_mode, store_test_mode, error_message)
        if probe_verdict == "confirmed_mismatch":
            confirmed += 1
            log.warning("Order %s: %s. %s", order["id"], probe_reason,
                        "would note" if DRY_RUN else "noting")
            if not DRY_RUN:
                note_order(order["id"], probe_reason)
            # One confirmed mismatch is enough evidence for the whole store's key.
            break

    log.info(
        "Done. checked %d order(s), %s.",
        checked,
        "confirmed a key mode mismatch" if confirmed else "no confirmed mismatch",
    )


if __name__ == "__main__":
    run()
