"""Find charges where a refund and a dispute both pulled money out.

A charge can be refunded by the store and later disputed by the buyer's bank.
Those are two separate withdrawals in Stripe, so the same sale can be paid for
twice by the merchant: once through the refund, once through the dispute plus
its fee. This walks recent disputes, checks each charge's refund history, and
reports every case where money left the account twice, adding an order note
with the estimated extra loss. Read only by default. Run on a schedule.

Guide: https://www.allanninal.dev/woocommerce/refund-and-dispute-double-reversal/
"""
import os
import time
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("refund_dispute_double_reversal")

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "sk_test_dummy")
WOO_URL = os.environ.get("WOO_STORE_URL", "https://example.com").rstrip("/")
AUTH = HTTPBasicAuth(
    os.environ.get("WOO_CONSUMER_KEY", "ck_dummy"),
    os.environ.get("WOO_CONSUMER_SECRET", "cs_dummy"),
)
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "30"))
DEFAULT_DISPUTE_FEE_CENTS = int(os.environ.get("DEFAULT_DISPUTE_FEE_CENTS", "1500"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def recent_disputes(lookback_days):
    since = int(time.time()) - lookback_days * 86400
    for dispute in stripe.Dispute.list(limit=100, created={"gte": since}).auto_paging_iter():
        yield dispute


def get_charge_with_refunds(charge_id):
    return stripe.Charge.retrieve(charge_id, expand=["refunds"])


def refunded_before(charge, cutoff_ts):
    """Total minor units (cents) refunded on this charge before cutoff_ts."""
    total = 0
    for refund in charge.get("refunds", {}).get("data", []):
        if refund["status"] == "succeeded" and refund["created"] <= cutoff_ts:
            total += refund["amount"]
    return total


def decide(dispute_amount, refunded_before_amount, dispute_fee=DEFAULT_DISPUTE_FEE_CENTS):
    """Pure decision function. All amounts are in minor units (cents).

    Returns a tuple of (action, reason, loss_cents).
    - "skip": nothing was refunded before the dispute, this is a normal dispute.
    - "double_reversal": the charge was already refunded, so the overlap
      between the refunded amount and the disputed amount, plus the dispute
      fee, is money that left the account twice.
    """
    if refunded_before_amount <= 0:
        return ("skip", "no refund existed before this dispute", 0)
    overlap = min(dispute_amount, refunded_before_amount)
    loss = overlap + dispute_fee
    return ("double_reversal", "charge was refunded before the dispute", loss)


def find_order_by_intent(intent_id):
    if not intent_id:
        return None
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"search": intent_id, "per_page": 5},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    for order in r.json():
        for meta in order.get("meta_data", []):
            if meta.get("key") == "_stripe_intent_id" and meta.get("value") == intent_id:
                return order
        if order.get("transaction_id") == intent_id:
            return order
    return None


def record_loss(order_id, dispute_id, loss_cents, currency):
    note = (
        f"Double reversal detected. Dispute {dispute_id} withdrew money on a charge "
        f"that was already refunded. Estimated extra loss: {loss_cents / 100:.2f} {currency.upper()}. "
        f"Review and submit evidence if the refund predates the dispute."
    )
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": note}, auth=AUTH, timeout=30,
    ).raise_for_status()


def run():
    flagged = 0
    total_loss_cents = 0
    for dispute in recent_disputes(LOOKBACK_DAYS):
        charge_id = dispute["charge"]
        charge = get_charge_with_refunds(charge_id)
        refunded = refunded_before(charge, dispute["created"])
        action, reason, loss = decide(dispute["amount"], refunded)
        if action == "skip":
            continue
        intent_id = charge.get("payment_intent")
        order = find_order_by_intent(intent_id)
        order_id = order["id"] if order else None
        log.warning(
            "Charge %s: %s. Extra loss %.2f %s. %s",
            charge_id, reason, loss / 100, dispute["currency"].upper(),
            "would record" if DRY_RUN else "recording",
        )
        if not DRY_RUN and order_id:
            record_loss(order_id, dispute["id"], loss, dispute["currency"])
        flagged += 1
        total_loss_cents += loss
    log.info(
        "Done. %d double reversal(s) found, total extra loss %.2f.",
        flagged, total_loss_cents / 100,
    )


if __name__ == "__main__":
    run()
