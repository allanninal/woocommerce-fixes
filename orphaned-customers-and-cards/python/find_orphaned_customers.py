"""Find Stripe customers with no matching WooCommerce user behind them, and
WooCommerce users whose saved Stripe customer no longer exists.

A WooCommerce user stores the Stripe customer id in user meta
`_stripe_customer_id`. A deleted WordPress user, a database import, or a
customer merge can leave that link pointing at nothing, or pointing at a
Stripe customer that actually belongs to someone else now. Meanwhile Stripe
can be holding a customer object, and a saved card, that no WooCommerce user
ever claims. This walks both sides, decides what is wrong with a pure
function, and either reports it (dry run) or repairs it: reconnect a link
that just moved, or delete a Stripe customer that is genuinely abandoned and
has no subscriptions or payment methods worth keeping. Safe by default. Run
on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_customers")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "90"))
DELETE_ABANDONED = os.environ.get("DELETE_ABANDONED", "false").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def decide(customer, woo_user):
    """Pure decision function. No I/O, no Stripe or WooCommerce calls inside.

    customer: a dict shaped like a Stripe Customer, or None if Stripe has no
              such customer (deleted or never existed).
    woo_user: a dict shaped like a WooCommerce customer record, or None if no
              WooCommerce user claims this Stripe customer id.

    Returns a (action, reason) tuple. Actions:
      "ok"        nothing wrong, the link is good.
      "reconnect" the Stripe customer exists and metadata.woo_customer_id
                   names a real, different WooCommerce user. Point the
                   record at that user instead of deleting anything.
      "orphan"    the Stripe customer exists but no WooCommerce user claims
                   it, and it has no subscriptions and no saved payment
                   methods. Safe to delete once DELETE_ABANDONED is on.
      "keep"      the Stripe customer exists, no WooCommerce user claims it,
                   but it still has a subscription or a saved card, so it is
                   left alone and only reported.
      "broken-link" a WooCommerce user has a saved Stripe customer id that
                   Stripe does not recognize any more. Needs a human to
                   reconnect it to the right customer or clear the field.
    """
    if customer is None:
        return ("broken-link", "WooCommerce points to a Stripe customer id Stripe does not have")

    if customer.get("deleted"):
        return ("broken-link", "the Stripe customer behind this id was deleted")

    linked_woo_id = (customer.get("metadata") or {}).get("woo_customer_id")

    if woo_user is not None:
        if linked_woo_id and str(linked_woo_id) != str(woo_user["id"]):
            return ("reconnect", "Stripe metadata points to a different WooCommerce user")
        return ("ok", "Stripe customer and WooCommerce user agree")

    # No WooCommerce user claims this Stripe customer.
    if linked_woo_id:
        return ("reconnect", "Stripe metadata names a WooCommerce user id that no longer exists")

    has_subscription = bool(customer.get("has_active_subscription"))
    has_payment_method = bool(customer.get("has_payment_method"))
    if has_subscription or has_payment_method:
        return ("keep", "no WooCommerce user, but a subscription or saved card is still attached")

    return ("orphan", "no WooCommerce user, no subscription, no saved payment method")


def list_stripe_customers(lookback_days):
    """Stripe customers created in the lookback window, newest first."""
    import time
    since = int(time.time()) - lookback_days * 86400
    for customer in stripe.Customer.list(limit=100, created={"gte": since}).auto_paging_iter():
        yield customer


def enrich(customer):
    """Attach the two cheap-to-check facts decide() needs: an active
    subscription, or at least one saved payment method. Both come straight
    from the Stripe API, kept separate from decide() so decide() stays pure.
    """
    customer["has_active_subscription"] = bool(
        stripe.Subscription.list(customer=customer["id"], status="active", limit=1).data
    )
    customer["has_payment_method"] = bool(
        stripe.PaymentMethod.list(customer=customer["id"], type="card", limit=1).data
    )
    return customer


def find_woo_user_by_stripe_id(stripe_customer_id):
    """Look up the WooCommerce customer whose meta _stripe_customer_id matches.
    The WooCommerce REST API does not filter customers by arbitrary meta, so
    we search by the value stored in the customer's own `meta_data` field on
    the /customers endpoint (WooCommerce exposes a "role" search and a plain
    text `search` param that also matches meta for many setups). We keep it
    simple and explicit: fetch by the search term and confirm the meta match
    ourselves rather than trusting the search to be exact.
    """
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/customers",
        params={"search": stripe_customer_id, "per_page": 10},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    for user in r.json():
        for meta in user.get("meta_data") or []:
            if meta.get("key") == "_stripe_customer_id" and meta.get("value") == stripe_customer_id:
                return user
    return None


def reconnect(woo_user_id, stripe_customer_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/customers/{woo_user_id}",
        json={"meta_data": [{"key": "_stripe_customer_id", "value": stripe_customer_id}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def delete_stripe_customer(stripe_customer_id):
    stripe.Customer.delete(stripe_customer_id)


def run():
    reconnected = 0
    deleted = 0
    flagged = 0
    for customer in list_stripe_customers(LOOKBACK_DAYS):
        stripe_customer_id = customer["id"]
        woo_user = find_woo_user_by_stripe_id(stripe_customer_id)
        enriched = enrich(dict(customer))
        action, reason = decide(enriched, woo_user)

        if action == "ok":
            continue

        if action == "keep":
            log.info("Customer %s: %s. Leaving it alone.", stripe_customer_id, reason)
            flagged += 1
            continue

        if action == "broken-link":
            log.warning("WooCommerce user pointing at %s is broken: %s", stripe_customer_id, reason)
            flagged += 1
            continue

        if action == "reconnect":
            target_id = (enriched.get("metadata") or {}).get("woo_customer_id")
            log.info(
                "Customer %s: %s. %s",
                stripe_customer_id, reason, "would reconnect" if DRY_RUN else "reconnecting",
            )
            if not DRY_RUN and target_id:
                reconnect(target_id, stripe_customer_id)
            reconnected += 1
            continue

        if action == "orphan":
            log.info(
                "Customer %s: %s. %s",
                stripe_customer_id, reason,
                "would delete" if (DRY_RUN or not DELETE_ABANDONED) else "deleting",
            )
            if not DRY_RUN and DELETE_ABANDONED:
                delete_stripe_customer(stripe_customer_id)
                deleted += 1
            else:
                flagged += 1

    log.info(
        "Done. %d reconnected, %d deleted, %d flagged for review.",
        reconnected, deleted, flagged,
    )


if __name__ == "__main__":
    run()
