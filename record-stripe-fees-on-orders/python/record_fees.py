"""Record the Stripe fee and net amount on each WooCommerce order.

WooCommerce reports show the gross order total, not what you actually kept after
Stripe's processing fee. This walks recent paid orders, reads the Stripe balance
transaction behind each charge, and saves the fee and net onto the order as meta,
so your reporting can show real profit. It only writes to orders that do not have
the fee recorded yet, so it is safe to run again and again. Run on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("record_fees")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FEE_META_KEY = "_stripe_fee"
NET_META_KEY = "_stripe_net"
PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def has_fee_recorded(order):
    return any(m.get("key") == FEE_META_KEY for m in order.get("meta_data") or [])


def fee_and_net(balance_transaction):
    """Convert a Stripe balance transaction (minor units) to fee and net in major units."""
    if not balance_transaction:
        return None
    fee = balance_transaction.get("fee")
    net = balance_transaction.get("net")
    if fee is None or net is None:
        return None
    return {"fee": round(fee / 100, 2), "net": round(net / 100, 2)}


def balance_for(intent_id):
    if not intent_id:
        return None
    try:
        pi = stripe.PaymentIntent.retrieve(intent_id, expand=["latest_charge.balance_transaction"])
    except stripe.error.InvalidRequestError:
        return None
    charge = pi.get("latest_charge")
    if not charge or isinstance(charge, str):
        return None
    return charge.get("balance_transaction")


def get(path, params=None):
    r = requests.get(f"{WOO_URL}/wp-json/wc/v3{path}", params=params or {}, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def save_fee(order_id, values):
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"meta_data": [
            {"key": FEE_META_KEY, "value": values["fee"]},
            {"key": NET_META_KEY, "value": values["net"]},
        ]},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def paid_orders():
    import datetime
    after = f"{datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    page = 1
    while True:
        batch = get("/orders", {"status": "processing,completed", "after": after, "per_page": 50, "page": page})
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def run():
    saved = 0
    for order in paid_orders():
        if has_fee_recorded(order):
            continue
        values = fee_and_net(balance_for(intent_id_of(order)))
        if values is None:
            continue
        log.info("Order %s fee %.2f net %.2f. %s", order["id"], values["fee"], values["net"],
                 "would save" if DRY_RUN else "saving")
        if not DRY_RUN:
            save_fee(order["id"], values)
        saved += 1
    log.info("Done. %d order(s) %s.", saved, "to record" if DRY_RUN else "recorded")


if __name__ == "__main__":
    run()
