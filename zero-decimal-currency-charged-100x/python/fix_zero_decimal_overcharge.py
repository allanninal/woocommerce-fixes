"""Find and refund WooCommerce orders in a zero decimal currency (JPY and friends)
that were charged 100x too much on Stripe.

Stripe expects "amount" in the smallest unit of the currency. For two decimal
currencies like USD that is cents, so $50.00 is 5000. Zero decimal currencies such
as JPY, KRW, and VND have no smaller unit, so PY5000 is just 5000, not 500000. Code
that always multiplies the order total by 100 before sending it to Stripe overcharges
every zero decimal order by a factor of 100. This walks recent orders in the given
currencies, compares what Stripe actually charged to what the order should have cost,
and refunds the difference. Read only by default. Run once, or on a schedule.
"""
import os
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_zero_decimal_overcharge")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# https://docs.stripe.com/currencies#zero-decimal
ZERO_DECIMAL_CURRENCIES = {
    "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg",
    "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
}

PAID_STATUSES = {"processing", "completed"}


def is_zero_decimal(currency):
    return (currency or "").lower() in ZERO_DECIMAL_CURRENCIES


def expected_minor_units(order_total, currency):
    """What Stripe's "amount" should be for this order total in this currency.

    Zero decimal currencies use the total as is (PY5000 -> 5000). Every other
    currency uses the total times 100 (rounded) the usual way ($50.00 -> 5000).
    """
    total = float(order_total)
    if is_zero_decimal(currency):
        return round(total)
    return round(total * 100)


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def decide(order, intent):
    """Pure decision: does this order need an overcharge refund, and for how much?

    Returns a tuple of (action, reason, overcharge_minor). overcharge_minor is the
    amount, in the intent's own minor units, that should be refunded. It is 0 unless
    action is "refund".
    """
    if order["status"] not in PAID_STATUSES:
        return ("skip", "order not in a paid state", 0)
    if not is_zero_decimal(order.get("currency")):
        return ("skip", "not a zero decimal currency", 0)
    if intent is None:
        return ("skip", "no Stripe PaymentIntent on this order", 0)
    if intent.get("status") != "succeeded":
        return ("skip", "Stripe payment did not succeed", 0)

    charged = intent.get("amount_received", 0)
    expected = expected_minor_units(order["total"], order.get("currency"))
    if charged <= expected:
        return ("ok", "charge matches the order total", 0)

    # A 100x overcharge lands very close to charged / 100 == expected. Require
    # that ratio (within a small tolerance) so we only touch the bug this script
    # targets, not some unrelated pricing mismatch.
    if expected <= 0 or abs(charged - expected * 100) > max(1, expected // 100):
        return ("mismatch", "overcharged but not by the 100x pattern", 0)

    already_refunded = intent.get("amount_refunded", 0) or 0
    overcharge = charged - expected
    remaining = overcharge - already_refunded
    if remaining <= 0:
        return ("ok", "overcharge already refunded", 0)

    return ("refund", "charged 100x the zero decimal total", remaining)


def get_intent(intent_id):
    if not intent_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intent_id)
    except stripe.error.InvalidRequestError:
        return None


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


def refund_overcharge(order, intent, overcharge_minor):
    charge_id = intent.get("latest_charge") or intent["id"]
    stripe.Refund.create(
        payment_intent=intent["id"] if charge_id == intent["id"] else None,
        charge=charge_id if charge_id != intent["id"] else None,
        amount=overcharge_minor,
        reason="duplicate",
        metadata={"reason": "zero_decimal_currency_100x_overcharge", "order_id": str(order["id"])},
    )
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order['id']}/notes",
        json={"note": f"Refunded a {overcharge_minor} unit overcharge caused by treating "
                      f"{order.get('currency')} as a two decimal currency. Stripe PaymentIntent "
                      f"{intent['id']}."},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    fixed = 0
    for order in paid_orders():
        intent = get_intent(intent_id_of(order))
        action, reason, overcharge_minor = decide(order, intent)
        if action == "mismatch":
            log.warning("Order %s: %s", order["id"], reason)
            continue
        if action != "refund":
            continue
        log.warning(
            "Order %s: %s. Overcharge is %s minor units. %s",
            order["id"], reason, overcharge_minor, "would refund" if DRY_RUN else "refunding",
        )
        if not DRY_RUN:
            refund_overcharge(order, intent, overcharge_minor)
        fixed += 1
    log.info("Done. %d order(s) %s.", fixed, "to refund" if DRY_RUN else "refunded")


if __name__ == "__main__":
    run()
