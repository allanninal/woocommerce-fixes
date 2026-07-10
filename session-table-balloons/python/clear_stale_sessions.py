"""Clear a bloated wp_woocommerce_sessions table, without cutting off a live checkout.

WooCommerce is supposed to prune expired session rows on its own, every time a
scheduled cleanup event runs. When that event stops firing (WP-Cron disabled, Action
Scheduler stuck, a host that kills long requests), expired rows never get removed and
the table grows without bound. Some stores have reported this table alone reaching
several gigabytes, almost all of it expired rows.

WooCommerce ships a REST-reachable maintenance tool that empties the sessions table:
PUT /wp-json/wc/v3/system_status/tools/clear_sessions. It is effective but blunt, it
wipes every session, including a shopper who is mid-checkout right now. So before we
run it we check Stripe for any PaymentIntent created in the last few minutes that is
still open (requires_action, processing, or requires_payment_method), using the
PaymentIntent id saved on the matching WooCommerce order's _stripe_intent_id meta (or
transaction_id as a fallback). If anyone looks like they are actively paying, we wait.

Safe by default. Run on a schedule.
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_stale_sessions")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
MAX_SESSIONS_MB = float(os.environ.get("MAX_SESSIONS_MB", "50"))
CHECKOUT_GUARD_MINUTES = int(os.environ.get("CHECKOUT_GUARD_MINUTES", "15"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

OPEN_INTENT_STATUSES = {"requires_action", "requires_confirmation", "processing", "requires_payment_method"}
LIVE_ORDER_STATUSES = {"pending", "on-hold", "checkout-draft"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def sessions_table_size_mb(system_status):
    """Read the sessions table's data + index size, in MB, from a system_status payload."""
    tables = ((system_status.get("database") or {}).get("database_tables") or {}).get("other") or {}
    row = tables.get("woocommerce_sessions") or tables.get("wp_woocommerce_sessions") or {}
    return float(row.get("data", 0) or 0) + float(row.get("index", 0) or 0)


def decide(sessions_size_mb, threshold_mb, open_checkout_count):
    """Pure decision: should we clear the sessions table right now?

    sessions_size_mb    -- current size (data + index, MB) of wp_woocommerce_sessions
    threshold_mb        -- size at which the table counts as bloated
    open_checkout_count -- number of recent orders with a Stripe PaymentIntent that is
                           still open (a shopper who may be mid-checkout right now)
    """
    if sessions_size_mb < threshold_mb:
        return ("skip", "sessions table is under the size threshold")
    if open_checkout_count > 0:
        return ("wait", "a checkout looks in progress, wait for it to settle")
    return ("clear", "sessions table is bloated and no checkout is in progress")


def get_system_status():
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/system_status", auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def recent_live_orders(guard_minutes):
    after = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - guard_minutes * 60))
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"status": ",".join(LIVE_ORDER_STATUSES), "after": after, "per_page": 50},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def count_open_checkouts(guard_minutes):
    open_count = 0
    for order in recent_live_orders(guard_minutes):
        intent = get_intent(intent_id_of(order))
        if intent is not None and intent.get("status") in OPEN_INTENT_STATUSES:
            open_count += 1
    return open_count


def clear_sessions():
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/system_status/tools/clear_sessions",
        auth=AUTH, timeout=60,
    ).raise_for_status()


def run():
    status = get_system_status()
    size_mb = sessions_table_size_mb(status)
    open_checkouts = count_open_checkouts(CHECKOUT_GUARD_MINUTES)
    action, reason = decide(size_mb, MAX_SESSIONS_MB, open_checkouts)

    if action == "skip":
        log.info("Sessions table is %.1f MB, under the %.1f MB threshold. Nothing to do.", size_mb, MAX_SESSIONS_MB)
        return
    if action == "wait":
        log.warning(
            "Sessions table is %.1f MB (over %.1f MB) but %d checkout(s) look in progress. %s",
            size_mb, MAX_SESSIONS_MB, open_checkouts, reason,
        )
        return

    log.info("Sessions table is %.1f MB (over %.1f MB) and no checkout is in progress. %s",
              size_mb, MAX_SESSIONS_MB, "Would clear it." if DRY_RUN else "Clearing it now.")
    if not DRY_RUN:
        clear_sessions()
        log.info("Cleared wp_woocommerce_sessions.")


if __name__ == "__main__":
    run()
