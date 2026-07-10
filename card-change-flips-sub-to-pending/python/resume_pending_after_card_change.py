"""Resume WooCommerce subscriptions left Pending after a verified card change.
Confirms the SetupIntent succeeded and its card matches before resuming.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/woocommerce/card-change-flips-sub-to-pending/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resume_pending_after_card_change")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def pending_subscriptions():
    """Yield every WooCommerce subscription currently on Pending, paging through the API."""
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/subscriptions",
            params={"status": "pending", "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        subs = r.json()
        if not subs:
            return
        for sub in subs:
            yield sub
        page += 1


def get_meta(sub, key):
    """Read one value out of a WooCommerce meta_data list by its key."""
    for m in sub.get("meta_data", []) or []:
        if m.get("key") == key:
            return m.get("value")
    return None


def intent_id_of(sub):
    """The saved Stripe SetupIntent id, from meta _stripe_intent_id or transaction_id."""
    meta_id = get_meta(sub, "_stripe_intent_id")
    if meta_id:
        return meta_id
    tid = sub.get("transaction_id")
    return tid if tid and tid.startswith("seti_") else None


def current_card_token(sub):
    """The Stripe payment method token currently saved on the subscription, if any."""
    return get_meta(sub, "_stripe_source_id") or get_meta(sub, "_payment_method_token")


def get_setup_intent(intent_id):
    """Look up a SetupIntent on Stripe. Returns None if there is no id or Stripe cannot find it."""
    if not intent_id:
        return None
    try:
        return stripe.SetupIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def decide(sub_status, intent, current_card_token):
    """Pure decision function. No I/O, safe to unit test.

    Returns a tuple of (action, reason) where action is one of:
      "skip"     - the subscription is not pending, nothing to do
      "wait"     - still waiting on the SetupIntent to resolve, leave it alone
      "mismatch" - the SetupIntent's card does not match what is saved, needs a human
      "resume"   - proven safe to set the subscription back to active
    """
    if sub_status != "pending":
        return ("skip", "subscription not pending")
    if intent is None:
        return ("wait", "no setup intent on file yet")
    if intent.get("status") != "succeeded":
        return ("wait", "setup intent has not succeeded")
    intent_pm = intent.get("payment_method")
    if not intent_pm or not current_card_token:
        return ("mismatch", "missing payment method to compare")
    if intent_pm != current_card_token:
        return ("mismatch", "setup intent card does not match saved card")
    return ("resume", "card change verified, safe to reactivate")


def resume(sub_id, intent_id):
    """Set the subscription back to active and leave a note explaining why."""
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}",
        json={"status": "active"},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/subscriptions/{sub_id}/notes",
        json={"note": f"Card change verified on Stripe SetupIntent {intent_id}. "
                      f"The confirmation back to the store was missed, so this was "
                      f"set back to active by the reconciler."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    resumed = 0
    for sub in pending_subscriptions():
        intent_id = intent_id_of(sub)
        intent = get_setup_intent(intent_id)
        action, reason = decide(sub["status"], intent, current_card_token(sub))
        if action in ("skip", "wait"):
            continue
        if action == "mismatch":
            log.warning("Subscription %s: %s", sub["id"], reason)
            continue
        log.info("Subscription %s: %s. %s", sub["id"], reason, "would resume" if DRY_RUN else "resuming")
        if not DRY_RUN:
            resume(sub["id"], intent_id)
        resumed += 1
    log.info("Done. %d subscription(s) %s.", resumed, "to resume" if DRY_RUN else "resumed")


if __name__ == "__main__":
    run()
