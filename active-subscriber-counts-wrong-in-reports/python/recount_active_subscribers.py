"""Recount the active subscriber total from real subscriptions, not the cached report.

WooCommerce Subscriptions reports read a stored total (a transient, a report table
row, or an option updated by a scheduled action) instead of counting live
subscriptions. When that cache misses a status change, an expired trial, or a failed
renewal that should have ended the subscription, the "Active subscribers" number on
the dashboard drifts from reality. This walks every subscription from the WooCommerce
REST API, decides with a pure function whether each one is a real active subscriber
right now, cross-checks a sample against Stripe when a subscription id is on the
order, and reports the corrected count. Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recount_active_subscribers")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
STRIPE_SAMPLE_SIZE = int(os.environ.get("STRIPE_SAMPLE_SIZE", "20"))

# Statuses WooCommerce Subscriptions itself treats as "active" for billing purposes.
ACTIVE_STATUSES = {"active"}
# Statuses that are still real subscribers even though billing is paused right now.
COUNTS_AS_SUBSCRIBER = {"active", "pending-cancel"}


def intent_id_of(subscription):
    """The saved Stripe subscription or PaymentIntent id, from meta or the last order."""
    for meta in subscription.get("meta_data") or []:
        if meta.get("key") == "_stripe_subscription_id" and meta.get("value"):
            return meta["value"]
    tid = subscription.get("transaction_id")
    return tid if tid and (tid.startswith("sub_") or tid.startswith("pi_")) else None


def is_real_subscriber(subscription):
    """Pure decision: does this one subscription count toward "active subscribers"?

    This is the rule the cached report skips. A subscription counts only when
    WooCommerce Subscriptions itself would treat it as active or pending-cancel
    (still billing or still owed one more charge), and it is not a free trial that
    has not converted, and it has not passed its end date.
    """
    status = subscription.get("status")
    if status not in COUNTS_AS_SUBSCRIBER:
        return False
    if subscription.get("trial_end") and not subscription.get("has_converted_from_trial", True):
        return False
    end = subscription.get("end_date")
    now = subscription.get("_now")
    if end and now and end <= now:
        return False
    return True


def recount(subscriptions):
    """Pure function: count real active subscribers out of a list of subscriptions."""
    return sum(1 for sub in subscriptions if is_real_subscriber(sub))


def decide(cached_count, real_count):
    """Pure function: decide whether the cached report total needs a repair.

    A small rounding style gap of zero is fine. Anything else is a drift worth
    reporting, and a large gap is worth flagging loudly.
    """
    diff = real_count - cached_count
    if diff == 0:
        return ("ok", "cached total matches the real count", diff)
    if abs(diff) <= 2:
        return ("drift", "small drift, safe to auto repair", diff)
    return ("drift-large", "large drift, review before trusting the auto repair", diff)


def subscription_amount_minor(subscription):
    return round(float(subscription.get("total", "0") or "0") * 100)


def stripe_status_agrees(subscription, stripe_subscription):
    """Pure function: does the live Stripe object agree this is a real subscriber?

    Used only to spot check a sample, since the WooCommerce status is the source of
    truth for what a "subscriber" means to this store, but a live Stripe status that
    disagrees is worth a warning.
    """
    if stripe_subscription is None:
        return None
    woo_says_active = is_real_subscriber(subscription)
    stripe_says_active = stripe_subscription.get("status") in {"active", "trialing", "past_due"}
    return woo_says_active == stripe_says_active


def get_stripe_subscription(sub_or_intent_id):
    if not sub_or_intent_id:
        return None
    try:
        if sub_or_intent_id.startswith("sub_"):
            return stripe.Subscription.retrieve(sub_or_intent_id)
        intent = stripe.PaymentIntent.retrieve(sub_or_intent_id)
        invoice_id = intent.get("invoice")
        if not invoice_id:
            return None
        invoice = stripe.Invoice.retrieve(invoice_id)
        sub_id = invoice.get("subscription")
        return stripe.Subscription.retrieve(sub_id) if sub_id else None
    except stripe.error.InvalidRequestError:
        return None


def all_subscriptions():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for sub in batch:
            yield sub
        page += 1


def get_cached_report_total():
    """The number the dashboard widget currently shows, read back from the report."""
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/reports/subscriptions/totals",
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    for row in r.json():
        if row.get("slug") == "active":
            return int(row.get("total", 0))
    return 0


def write_corrected_total(real_count):
    """Store the corrected total the same place the report reads it from."""
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/settings/subscriptions/woocommerce_subscriptions_active_count_cache",
        json={"value": str(real_count)},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    subscriptions = list(all_subscriptions())
    real_count = recount(subscriptions)
    cached_count = get_cached_report_total()
    action, reason, diff = decide(cached_count, real_count)

    if action == "ok":
        log.info("Report is correct. Active subscribers: %d.", real_count)
        return

    log.warning(
        "Active subscriber report is wrong. cached=%d real=%d diff=%+d (%s)",
        cached_count, real_count, diff, reason,
    )

    sample = subscriptions[:STRIPE_SAMPLE_SIZE]
    disagreements = 0
    for sub in sample:
        stripe_sub = get_stripe_subscription(intent_id_of(sub))
        agrees = stripe_status_agrees(sub, stripe_sub)
        if agrees is False:
            disagreements += 1
            log.warning(
                "Subscription %s: Stripe status disagrees with WooCommerce status.",
                sub.get("id"),
            )
    if disagreements:
        log.warning(
            "%d of %d sampled subscriptions disagree with Stripe. Investigate before trusting the repair.",
            disagreements, len(sample),
        )

    if action == "drift-large" and not DRY_RUN:
        log.warning("Large drift found. Not auto repairing. Re-run with the report reviewed first.")
        return

    log.info("%s repair the cached total from %d to %d.", "Would" if DRY_RUN else "Applying", cached_count, real_count)
    if not DRY_RUN:
        write_corrected_total(real_count)
    log.info("Done. Real active subscriber count is %d.", real_count)


if __name__ == "__main__":
    run()
