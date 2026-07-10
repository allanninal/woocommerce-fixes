"""Record the real settlement currency and amount behind each cross-currency order.

A buyer can check out in one currency (the presentment currency, what WooCommerce
shows and stores as the order total) while Stripe actually settles the charge into
your payout currency (the settlement currency) at its own exchange rate. WooCommerce
never sees that conversion, so your order total and your accounting books disagree
with what Stripe actually paid out. This walks recent paid orders, reads the Stripe
balance transaction behind each charge, and when the presentment currency does not
match the settlement currency, writes the settled amount, currency, and exchange
rate onto the order as meta so reports reconcile. It only writes orders that do not
already have the settlement meta recorded, so it is safe to run again and again.
Read only by default. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/presentment-vs-settlement-currency/
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("record_settlement_currency")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

SETTLEMENT_META_KEY = "_stripe_settlement_amount"
SETTLEMENT_CURRENCY_META_KEY = "_stripe_settlement_currency"
EXCHANGE_RATE_META_KEY = "_stripe_exchange_rate"
PAID_STATUSES = {"processing", "completed"}


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def has_settlement_recorded(order):
    return any(m.get("key") == SETTLEMENT_META_KEY for m in order.get("meta_data") or [])


def order_amount_minor(order):
    """Order total in minor units, in the order's presentment currency."""
    return round(float(order["total"]) * 100)


def decide(order, balance_transaction):
    """Pure decision: what to do with this order given its Stripe balance transaction.

    balance_transaction looks like a Stripe BalanceTransaction: it carries the
    settled `amount` and `currency` (the payout currency) plus, when the charge
    was presented in a different currency, an `exchange_rate`. The presentment
    amount and currency live on the order itself (order["total"], order["currency"]).
    """
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order not in a paid state")
    if has_settlement_recorded(order):
        return ("skip", "settlement already recorded")
    if balance_transaction is None:
        return ("orphan", "no Stripe balance transaction found for a paid order")

    settlement_currency = balance_transaction["currency"]
    presentment_currency = order["currency"]

    if settlement_currency.lower() == presentment_currency.lower():
        return ("same-currency", "presentment and settlement currency match, nothing to reconcile")

    exchange_rate = balance_transaction.get("exchange_rate")
    if not exchange_rate:
        return ("mismatch", "currencies differ but Stripe reported no exchange rate")

    return ("record", "presentment and settlement currency differ, recording the real settled amount")


def get_balance_transaction(intent_id):
    if not intent_id:
        return None
    try:
        pi = stripe.PaymentIntent.retrieve(intent_id, expand=["latest_charge.balance_transaction"])
    except stripe.error.InvalidRequestError:
        return None
    charge = pi.get("latest_charge")
    if not charge or isinstance(charge, str):
        return None
    bt = charge.get("balance_transaction")
    if not bt or isinstance(bt, str):
        return None
    return bt


def paid_orders():
    page = 1
    after = f"{__import__('datetime').date.today() - __import__('datetime').timedelta(days=LOOKBACK_DAYS)}T00:00:00"
    while True:
        r = requests.get(
            f"{WOO_URL}/wp-json/wc/v3/orders",
            params={"status": "processing,completed", "after": after, "per_page": 50, "page": page},
            auth=AUTH, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            return
        for order in batch:
            yield order
        page += 1


def record_settlement(order_id, balance_transaction):
    note = (
        f"Recorded settlement: {balance_transaction['amount'] / 100:.2f} "
        f"{balance_transaction['currency'].upper()} at exchange rate "
        f"{balance_transaction['exchange_rate']}. The order total is in a different "
        f"presentment currency than what Stripe actually settled."
    )
    requests.put(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}",
        json={"meta_data": [
            {"key": SETTLEMENT_META_KEY, "value": balance_transaction["amount"]},
            {"key": SETTLEMENT_CURRENCY_META_KEY, "value": balance_transaction["currency"]},
            {"key": EXCHANGE_RATE_META_KEY, "value": str(balance_transaction["exchange_rate"])},
        ]},
        auth=AUTH, timeout=30,
    ).raise_for_status()
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": note},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    recorded = 0
    for order in paid_orders():
        balance_transaction = get_balance_transaction(intent_id_of(order))
        action, reason = decide(order, balance_transaction)
        if action == "orphan":
            log.warning("Order %s: %s", order["id"], reason)
            continue
        if action in ("skip", "same-currency", "mismatch"):
            if action == "mismatch":
                log.warning("Order %s: %s", order["id"], reason)
            continue
        log.info("Order %s: %s. %s", order["id"], reason, "would record" if DRY_RUN else "recording")
        if not DRY_RUN:
            record_settlement(order["id"], balance_transaction)
        recorded += 1
    log.info("Done. %d order(s) %s.", recorded, "to record" if DRY_RUN else "recorded")


if __name__ == "__main__":
    run()
