"""Merge duplicate Stripe customers that share one shopper's email.

A shopper can end up with several Stripe Customer objects tied to the same
email: one made at guest checkout, one made when they later created an
account, one made by a retried checkout after a timeout. Each Customer keeps
its own saved cards and its own history, so "My account" shows no saved card,
support cannot see the full order history in one place, and a saved card on
an old customer can no longer be charged for a subscription renewal.

This walks the WooCommerce customers, groups the matching Stripe Customer
objects by email, picks one survivor per email, moves every saved payment
method from the other customers onto the survivor, repoints the WooCommerce
user's `_stripe_customer_id` meta and any paid orders' `_stripe_customer_id`
order meta to the survivor, then leaves a note. Duplicate customers are never
deleted, only detached, so nothing is destroyed. Read only by default. Run on
a schedule or by hand after a support ticket names an email.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("merge_duplicate_customers")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def order_amount_minor(order):
    """Order total in cents. Used only to log what moves with the merge."""
    return round(float(order["total"]) * 100)


def pick_survivor(customers):
    """Pure decision function. Given every Stripe Customer for one email,
    pick the one to keep and list the rest as duplicates to fold in.

    customers: list of dicts, each with at minimum:
      id, created (unix seconds), order_count (int), has_subscription (bool)

    Rule, in order:
      1. A customer already attached to an active subscription always wins,
         because moving a subscription is riskier than moving a saved card.
      2. Otherwise the customer with the most orders wins, since that is the
         history a shopper and support most need in one place.
      3. Ties go to the oldest customer (smallest created), since that id is
         more likely to already be saved in emails, invoices, and bookmarks.

    Returns (survivor, duplicates), or (None, []) when there is nothing to
    merge (zero or one customer for the email).
    """
    if len(customers) < 2:
        return (customers[0] if customers else None, [])

    with_sub = [c for c in customers if c.get("has_subscription")]
    pool = with_sub if with_sub else customers

    survivor = sorted(pool, key=lambda c: (-c.get("order_count", 0), c["created"]))[0]
    duplicates = [c for c in customers if c["id"] != survivor["id"]]
    return (survivor, duplicates)


def decide(email, customers):
    """Pure. Turn a group of same-email customers into an action plan.

    Returns a dict: {"action": "skip"|"merge", "reason": str,
                      "survivor": customer|None, "duplicates": [customer]}
    """
    if len(customers) < 2:
        return {"action": "skip", "reason": "only one Stripe customer for this email",
                "survivor": customers[0] if customers else None, "duplicates": []}

    survivor, duplicates = pick_survivor(customers)
    reason = "found {} Stripe customers for one email, merging into {}".format(
        len(customers), survivor["id"]
    )
    return {"action": "merge", "reason": reason, "survivor": survivor, "duplicates": duplicates}


def group_by_email(customers):
    """Pure. Group a flat list of Stripe customers by lowercased, trimmed email.
    Customers with no email are dropped, since there is nothing to match them on.
    """
    groups = {}
    for c in customers:
        email = (c.get("email") or "").strip().lower()
        if not email:
            continue
        groups.setdefault(email, []).append(c)
    return groups


# --- I/O below this line. Nothing above touches the network. ---

def list_stripe_customers_by_email(email):
    """All Stripe Customer objects for one email, newest last, enriched with
    order_count and has_subscription so pick_survivor can decide.
    """
    out = []
    for c in stripe.Customer.list(email=email, limit=100).auto_paging_iter():
        subs = stripe.Subscription.list(customer=c.id, status="active", limit=1)
        out.append({
            "id": c.id,
            "email": c.email,
            "created": c.created,
            "order_count": order_count_for_customer(c.id),
            "has_subscription": len(subs.data) > 0,
        })
    return sorted(out, key=lambda c: c["created"])


def order_count_for_customer(stripe_customer_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"search": stripe_customer_id, "per_page": 1},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    return int(r.headers.get("X-WP-Total", "0"))


def woo_users_with_stripe_id():
    """WordPress/WooCommerce customers that have a `_stripe_customer_id`
    stored in their user meta, one row per shopper.
    """
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/customers",
            params={"per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for user in batch:
            yield user
        page += 1


def move_payment_methods(survivor_id, duplicate_id):
    """Reattach every saved card on a duplicate customer to the survivor.
    Stripe cannot move a customer's default source directly, so each
    PaymentMethod is detached from the duplicate and attached to the survivor.
    """
    methods = stripe.PaymentMethod.list(customer=duplicate_id, type="card")
    for pm in methods.auto_paging_iter():
        stripe.PaymentMethod.detach(pm.id)
        stripe.PaymentMethod.attach(pm.id, customer=survivor_id)


def repoint_user(user_id, survivor_id):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/customers/{user_id}",
        json={"meta_data": [{"key": "_stripe_customer_id", "value": survivor_id}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def merge_customer(email, survivor, duplicates):
    for dup in duplicates:
        move_payment_methods(survivor["id"], dup["id"])
        stripe.Customer.modify(
            dup["id"],
            metadata={"merged_into": survivor["id"], "merge_reason": "duplicate email " + email},
        )
    for user in woo_users_with_stripe_id():
        current = next(
            (m["value"] for m in (user.get("meta_data") or []) if m.get("key") == "_stripe_customer_id"),
            None,
        )
        if current in [d["id"] for d in duplicates]:
            repoint_user(user["id"], survivor["id"])


def run():
    merged = 0
    seen_emails = set()
    for user in woo_users_with_stripe_id():
        email = (user.get("email") or "").strip().lower()
        if not email or email in seen_emails:
            continue
        seen_emails.add(email)

        customers = list_stripe_customers_by_email(email)
        plan = decide(email, customers)
        if plan["action"] == "skip":
            continue

        log.info(
            "%s: %s. %s",
            email, plan["reason"], "would merge" if DRY_RUN else "merging",
        )
        if not DRY_RUN:
            merge_customer(email, plan["survivor"], plan["duplicates"])
        merged += 1

    log.info("Done. %d email(s) %s.", merged, "to merge" if DRY_RUN else "merged")


if __name__ == "__main__":
    run()
