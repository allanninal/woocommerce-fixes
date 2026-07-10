"""Walk every WooCommerce order on a large store without dropping rows.

Paging the REST API with page= and per_page= alone is unsafe once the store
is busy: WooCommerce sorts by date by default, and dates are not unique or
stable while new orders keep landing or refunds change updated_at. A row
can slide from page 2 to page 1 between two requests and never appear in
either page you actually fetched, or appear in both.

This walks orders with a stable sort (orderby=id&order=asc) and an id
floor instead of a page number, so a row can only be seen once and nothing
between two ids can be skipped. It cross-checks each order's saved Stripe
PaymentIntent id (meta _stripe_intent_id, falling back to transaction_id)
and reports anything unpaid that Stripe already settled. Read only by
default. Run on a schedule or as a one-off backfill.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("paginate_orders")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "100"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide_batch(orders, last_seen_id):
    """Pure. Given one fetched page and the id floor used to fetch it,
    return which orders are new to process, how many were unexpected
    repeats, and the new floor for the next request.

    An order counts as new only when its id is strictly greater than the
    floor. A repeat (id at or below the floor) means the server re-served
    a row you already passed, exactly the failure mode a naive page= walk
    hides on a table that keeps changing while you scan it.
    """
    new_orders = []
    repeats = 0
    highest = last_seen_id
    for order in orders:
        oid = order["id"]
        if last_seen_id is not None and oid <= last_seen_id:
            repeats += 1
            continue
        new_orders.append(order)
        if highest is None or oid > highest:
            highest = oid
    return {"new_orders": new_orders, "repeats": repeats, "next_floor": highest}


def order_amount_minor(order):
    return round(float(order["total"]) * 100)


def decide(order, intent):
    """Pure. Given one order and its Stripe PaymentIntent (or None), decide
    whether the order needs repair. Only orders Stripe confirms as paid,
    but WooCommerce still shows as unpaid, are worth touching.
    """
    if intent is None:
        return ("skip", "no Stripe PaymentIntent on this order")
    if order["status"] in PAID_STATUSES:
        return ("skip", "order already paid")
    if intent.get("status") != "succeeded":
        return ("skip", "intent not succeeded")
    if abs(order_amount_minor(order) - intent.get("amount_received", 0)) > 1:
        return ("mismatch", "amount does not match the Stripe charge")
    return ("fix", "paid in Stripe, missed during pagination, still unpaid in Woo")


def fetch_page(min_id, page_size):
    """One page, sorted by id ascending, starting strictly after min_id.
    WooCommerce has no after_id filter, so we ask for rows whose id is at
    least min_id + 1 by combining orderby=id with the include-nothing-below
    trick: request the next page_size rows in id order and let decide_batch
    drop anything at or below the floor. That drop is safe because ids are
    assigned once and never reused or reordered.
    """
    params = {"orderby": "id", "order": "asc", "per_page": page_size}
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3/orders", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def walk_all_orders(page_size=None):
    """Yield every order exactly once, using an id floor instead of a page
    number. Stops when a fetch returns no id past the current floor.
    """
    page_size = page_size or PAGE_SIZE
    last_seen_id = None
    while True:
        batch = fetch_page(last_seen_id, page_size)
        if not batch:
            return
        result = decide_batch(batch, last_seen_id)
        for order in result["new_orders"]:
            yield order
        if result["next_floor"] == last_seen_id:
            # nothing past our floor came back, the walk is caught up
            return
        last_seen_id = result["next_floor"]


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


def mark_processing(order_id, intent):
    charge_id = intent.get("latest_charge") or intent["id"]
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"status": "processing", "transaction_id": charge_id},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": f"Repaired by the pagination sweep. Stripe PaymentIntent {intent['id']} "
                      f"was succeeded but this order was missed by an earlier page walk."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    scanned = 0
    for order in walk_all_orders():
        scanned += 1
        intent = get_intent(intent_id_of(order))
        action, reason = decide(order, intent)
        if action != "fix":
            if action == "mismatch":
                log.warning("Order %s amount mismatch: %s", order["id"], reason)
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would fix" if DRY_RUN else "fixing")
        if not DRY_RUN:
            mark_processing(order["id"], intent)
        fixed += 1
    log.info("Scanned %d order(s). %d %s.", scanned, fixed, "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
