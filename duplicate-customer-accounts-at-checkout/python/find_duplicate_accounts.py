"""Find WordPress or WooCommerce customer accounts that got duplicated for one
email address during checkout.

A checkout race (a double click, a slow network retry, or two tabs) can call
"create account" twice before the first request finishes, so WooCommerce ends up
with two separate customer accounts for one shopper: one with the order history,
one empty. This walks recent customers, groups them by a normalized email, and
for each pair reads the saved Stripe PaymentIntent on their orders to confirm
both accounts really were paid by the same person before it reports a merge
plan. Read only by default. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_accounts")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def normalize_email(email):
    """Lowercase and trim, so Person@Shop.com and person@shop.com group together."""
    return (email or "").strip().lower()


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def stripe_customer_of(order, get_intent):
    """The Stripe Customer id behind an order's payment, if we can find one."""
    intent = get_intent(intent_id_of(order))
    if intent is None:
        return None
    customer = intent.get("customer")
    return customer if isinstance(customer, str) else None


def group_by_email(customers):
    """Group a flat list of WooCommerce customers by normalized email."""
    groups = {}
    for customer in customers:
        key = normalize_email(customer.get("email"))
        if not key:
            continue
        groups.setdefault(key, []).append(customer)
    return {email: group for email, group in groups.items() if len(group) > 1}


def pick_survivor(customers):
    """The account to keep: most orders first, then the account created first."""
    return sorted(
        customers,
        key=lambda c: (-c.get("orders_count", 0), c.get("date_created") or ""),
    )[0]


def decide(email, customers, orders_by_customer, get_intent):
    """Pure decision for one email's group of duplicate customer accounts.

    Returns (action, reason, survivor, duplicates):
      - "merge": duplicates have no orders, or their orders trace to the same
        Stripe customer as the survivor's orders. Safe to repoint and remove.
      - "review": a duplicate has orders that trace to a *different* Stripe
        customer than the survivor. Do not auto merge, a human should look.
      - "skip": fewer than two accounts share this email.
    """
    if len(customers) < 2:
        return ("skip", "not a duplicate", None, [])

    survivor = pick_survivor(customers)
    duplicates = [c for c in customers if c["id"] != survivor["id"]]

    survivor_stripe_ids = {
        stripe_customer_of(o, get_intent)
        for o in orders_by_customer.get(survivor["id"], [])
    }
    survivor_stripe_ids.discard(None)

    for dup in duplicates:
        dup_orders = orders_by_customer.get(dup["id"], [])
        if not dup_orders:
            continue
        dup_stripe_ids = {
            stripe_customer_of(o, get_intent) for o in dup_orders
        }
        dup_stripe_ids.discard(None)
        if dup_stripe_ids and survivor_stripe_ids and dup_stripe_ids.isdisjoint(survivor_stripe_ids):
            return (
                "review",
                f"duplicate account {dup['id']} paid through a different Stripe customer, needs a human",
                survivor,
                duplicates,
            )

    return ("merge", "same email, same payer, safe to merge", survivor, duplicates)


def list_customers():
    page = 1
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/customers",
            params={"per_page": 100, "page": page, "orderby": "registered_date", "order": "desc"},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for customer in batch:
            yield customer
        page += 1


def orders_for_customer(customer_id):
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"customer": customer_id, "per_page": 50},
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


def repoint_orders(duplicate_id, survivor_id, orders):
    for order in orders:
        requests.put(
            f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}",
            json={"customer_id": survivor_id},
            auth=AUTH, timeout=30,
        ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/customers/{survivor_id}",
        json={"meta_data": [{"key": "_merged_duplicate_account", "value": str(duplicate_id)}]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    reported = 0
    orders_by_customer = {}
    all_customers = list(list_customers())
    for group in group_by_email(all_customers).values():
        for customer in group:
            orders_by_customer[customer["id"]] = orders_for_customer(customer["id"])

    for email, group in group_by_email(all_customers).items():
        action, reason, survivor, duplicates = decide(email, group, orders_by_customer, get_intent)
        if action == "skip":
            continue
        if action == "review":
            log.warning("Email %s: %s", email, reason)
            reported += 1
            continue
        log.info(
            "Email %s: %s. Survivor %s, merge %s.",
            email, reason, survivor["id"], [d["id"] for d in duplicates],
        )
        if not DRY_RUN:
            for dup in duplicates:
                repoint_orders(dup["id"], survivor["id"], orders_by_customer.get(dup["id"], []))
        reported += 1
    log.info("Done. %d duplicate email group(s) %s.", reported, "to merge" if DRY_RUN else "processed")


if __name__ == "__main__":
    run()
