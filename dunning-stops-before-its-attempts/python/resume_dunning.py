"""Resume a WooCommerce Subscriptions dunning cycle that stopped early.

WooCommerce Subscriptions retries a failed renewal on a schedule (for example
attempt 1 after a day, attempt 2 after three days, attempt 3 after five days),
then only cancels or leaves the subscription on hold once every configured
attempt has run. Sometimes the schedule dies early: a cron miss, a paused
Action Scheduler queue, or a worker that throws before it books the next
retry. The subscription is left on-hold with attempts still unused, and
nothing tries the card again.

This walks subscriptions that are on-hold with unused attempts, reads the
saved Stripe payment method from the renewal order, and if the card has not
already been retried since the subscription went quiet, charges the next
attempt itself and records it, the same way the missed retry would have.

Read the PaymentIntent id from order meta _stripe_intent_id, falling back to
transaction_id. Money math stays in minor units (cents). Safe by default,
DRY_RUN defaults to "true".
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resume_dunning")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
MAX_ATTEMPTS = int(os.environ.get("DUNNING_MAX_ATTEMPTS", "3"))
STALL_HOURS = int(os.environ.get("DUNNING_STALL_HOURS", "36"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

STUCK_SUB_STATUSES = {"on-hold"}


def meta_value(obj, key):
    """Read one value out of a WooCommerce meta_data list."""
    for meta in obj.get("meta_data") or []:
        if meta.get("key") == key and meta.get("value") not in (None, ""):
            return meta["value"]
    return None


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    value = meta_value(order, "_stripe_intent_id")
    if value:
        return value
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def dunning_attempt_count(subscription):
    """How many retry attempts have already run, from subscription meta."""
    value = meta_value(subscription, "_dunning_attempt_count")
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def hours_since_last_attempt(subscription, now_ts):
    """Hours since the last recorded retry, or a large number if never recorded."""
    value = meta_value(subscription, "_dunning_last_attempt_ts")
    try:
        last_ts = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, (now_ts - last_ts) / 3600)


def order_amount_minor(order):
    # Works for two decimal currencies. Zero decimal currencies (JPY and friends)
    # have their own guide, since 50.00 is wrong for those.
    return round(float(order["total"]) * 100)


def decide(subscription, renewal_order, now_ts, max_attempts=MAX_ATTEMPTS, stall_hours=STALL_HOURS):
    """Pure decision: should we resume dunning on this subscription right now?

    Returns a (action, reason) tuple. action is one of:
      "skip"   - nothing to do, leave it alone
      "wait"   - attempts remain but the stall window has not passed yet
      "resume" - attempts remain, the schedule has gone quiet, retry now
      "exhausted" - every configured attempt has already run
    """
    if subscription.get("status") not in STUCK_SUB_STATUSES:
        return ("skip", "subscription is not on-hold")
    if renewal_order is None:
        return ("skip", "no renewal order to retry")
    attempts = dunning_attempt_count(subscription)
    if attempts >= max_attempts:
        return ("exhausted", "every configured retry attempt has already run")
    idle_hours = hours_since_last_attempt(subscription, now_ts)
    if idle_hours is not None and idle_hours < stall_hours:
        return ("wait", "still inside the normal wait between attempts")
    return ("resume", f"attempt {attempts + 1} of {max_attempts} never ran")


def get_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "on-hold", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            yield sub
        page += 1


def get_last_renewal_order(subscription):
    order_ids = subscription.get("_links", {}).get("orders")
    related = subscription.get("related_orders") or subscription.get("order_id")
    order_id = related if isinstance(related, int) else subscription.get("last_order_id")
    if not order_id:
        return None
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}", auth=AUTH, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def retry_charge(subscription, order):
    """Charge the saved payment method again for the amount of the renewal order."""
    payment_method = meta_value(order, "_stripe_source_id") or meta_value(order, "_payment_method_id")
    customer_id = meta_value(subscription, "_stripe_customer_id")
    intent = stripe.PaymentIntent.create(
        amount=order_amount_minor(order),
        currency=(order.get("currency") or "usd").lower(),
        customer=customer_id,
        payment_method=payment_method,
        off_session=True,
        confirm=True,
        metadata={"subscription_id": str(subscription["id"]), "order_id": str(order["id"])},
    )
    return intent


def record_attempt(subscription, order, intent, now_ts):
    attempts = dunning_attempt_count(subscription) + 1
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription['id']}",
        json={"meta_data": [
            {"key": "_dunning_attempt_count", "value": str(attempts)},
            {"key": "_dunning_last_attempt_ts", "value": str(int(now_ts))},
        ]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
        json={"meta_data": [{"key": "_stripe_intent_id", "value": intent["id"]}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    if intent.get("status") == "succeeded":
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
            json={"status": "processing", "transaction_id": intent.get("latest_charge") or intent["id"]},
            auth=AUTH, timeout=30,
        ).raise_for_status()
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions/{subscription['id']}",
            json={"status": "active"},
            auth=AUTH, timeout=30,
        ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Resumed dunning attempt {attempts}. Stripe PaymentIntent {intent['id']} "
                      f"came back {intent.get('status')}. Triggered by the resume_dunning job "
                      f"because the retry schedule had gone quiet."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    import time
    now_ts = time.time()
    resumed = 0
    for subscription in get_subscriptions():
        order = get_last_renewal_order(subscription)
        action, reason = decide(subscription, order, now_ts)
        if action in ("skip", "wait"):
            continue
        if action == "exhausted":
            log.info("Subscription %s: %s. Leaving it for a human to cancel or retry manually.",
                      subscription["id"], reason)
            continue
        log.info("Subscription %s: %s. %s", subscription["id"], reason,
                  "would resume" if DRY_RUN else "resuming")
        if not DRY_RUN:
            intent_id = intent_id_of(order)
            log.info("Last known PaymentIntent for order %s was %s", order["id"], intent_id)
            intent = retry_charge(subscription, order)
            record_attempt(subscription, order, intent, now_ts)
        resumed += 1
    log.info("Done. %d subscription(s) %s.", resumed, "to resume" if DRY_RUN else "resumed")


if __name__ == "__main__":
    run()
