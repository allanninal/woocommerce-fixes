"""Build a per payout report that ties a Stripe payout to the WooCommerce orders behind it.

A bank deposit is never the sum of the order totals you see in WooCommerce. Stripe groups
many charges, refunds, and fees into one payout, converts everything to minor units, and
settles a few days after the charge. Nothing in WooCommerce shows you that grouping. This
script reads one payout's balance transactions from Stripe, matches each charge to its
WooCommerce order by the saved PaymentIntent id, and builds a line by line report where the
payout total, the sum of the matched order net amounts, and Stripe's own totals all agree to
the cent. Any line that cannot be matched, or any payout that does not tie out, is flagged for
a person to look at. Read only by default. Run once per payout, or on a schedule shortly after
each payout lands.
"""
import os
import csv
import io
import logging
import stripe
import requests
from requests.auth import HTTPBasicAuth

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("build_payout_report")

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
WOO_URL = os.environ["WOO_STORE_URL"].rstrip("/")
AUTH = HTTPBasicAuth(os.environ["WOO_CONSUMER_KEY"], os.environ["WOO_CONSUMER_SECRET"])
TIE_OUT_TOLERANCE_MINOR = int(os.environ.get("TIE_OUT_TOLERANCE_MINOR", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Balance transaction types that represent a customer charge landing in the payout.
CHARGE_TYPES = {"charge", "payment"}
# Types that reduce the payout but are not tied to a single order line.
ADJUSTING_TYPES = {"refund", "payment_refund", "adjustment", "stripe_fee"}


def source_intent_id(balance_txn):
    """The PaymentIntent id behind a balance transaction, when there is one."""
    source = balance_txn.get("source")
    if isinstance(source, dict):
        return source.get("payment_intent")
    return None


def intent_id_of(order):
    """The saved Stripe PaymentIntent id, from meta _stripe_intent_id or transaction_id."""
    for meta in order.get("meta_data") or []:
        if meta.get("key") == "_stripe_intent_id" and meta.get("value"):
            return meta["value"]
    tid = order.get("transaction_id")
    return tid if tid and tid.startswith("pi_") else None


def order_amount_minor(order):
    """Order total in minor units (cents). Two decimal currencies only; zero decimal
    currencies such as JPY have their own guide, since round(x * 100) is wrong there."""
    return round(float(order["total"]) * 100)


def line_for(balance_txn, order):
    """Pure decision: given one balance transaction from a payout and the WooCommerce
    order it points to (or None), classify the line for the report. No I/O here, so
    this is fully unit testable.

    Returns a dict with the fields the report needs: txn id, type, net amount in minor
    units, matched order id (or None), and a status explaining the match.
    """
    net_minor = balance_txn.get("net", 0)
    txn_type = balance_txn.get("type")
    intent_id = source_intent_id(balance_txn)

    row = {
        "balance_transaction_id": balance_txn.get("id"),
        "type": txn_type,
        "net_minor": net_minor,
        "intent_id": intent_id,
        "order_id": order.get("id") if order else None,
    }

    if txn_type not in CHARGE_TYPES:
        row["status"] = "not_a_charge"
        row["note"] = f"'{txn_type}' line, included in the payout total but has no single order to match"
        return row

    if not intent_id:
        row["status"] = "unmatched"
        row["note"] = "no PaymentIntent on this balance transaction"
        return row

    if order is None:
        row["status"] = "orphan"
        row["note"] = f"no WooCommerce order has PaymentIntent {intent_id} on record"
        return row

    order_minor = order_amount_minor(order)
    drift = order_minor - net_minor
    if abs(drift) <= TIE_OUT_TOLERANCE_MINOR:
        row["status"] = "matched"
        row["note"] = "order total matches the net amount in the payout"
    else:
        row["status"] = "mismatch"
        row["note"] = f"order total and payout net disagree by {drift} minor units"
    return row


def summarize(payout, rows):
    """Pure roll up: does the report tie out to the cent for this payout."""
    matched_net = sum(r["net_minor"] for r in rows if r["status"] in ("matched", "mismatch"))
    other_net = sum(r["net_minor"] for r in rows if r["status"] == "not_a_charge")
    accounted_minor = matched_net + other_net
    payout_minor = payout.get("amount", 0)
    drift = payout_minor - accounted_minor
    ties_out = abs(drift) <= TIE_OUT_TOLERANCE_MINOR
    unmatched = [r for r in rows if r["status"] in ("unmatched", "orphan", "mismatch")]
    return {
        "payout_id": payout.get("id"),
        "payout_amount_minor": payout_minor,
        "accounted_minor": accounted_minor,
        "drift_minor": drift,
        "ties_out": ties_out,
        "unmatched_count": len(unmatched),
    }


def list_payout_transactions(payout_id):
    for txn in stripe.BalanceTransaction.list(payout=payout_id, limit=100).auto_paging_iter():
        yield txn


def get_order_by_intent(intent_id):
    if not intent_id:
        return None
    r = requests.get(
        f"{WOO_URL}/wp-json/wc/v3/orders",
        params={"search": intent_id, "per_page": 5},
        auth=AUTH, timeout=30,
    )
    r.raise_for_status()
    for order in r.json():
        if intent_id_of(order) == intent_id:
            return order
    return None


def write_note(order_id, note):
    requests.post(
        f"{WOO_URL}/wp-json/wc/v3/orders/{order_id}/notes",
        json={"note": note},
        auth=AUTH, timeout=30,
    ).raise_for_status()


def build_report(payout_id):
    payout = stripe.Payout.retrieve(payout_id)
    rows = []
    for txn in list_payout_transactions(payout_id):
        intent_id = source_intent_id(txn)
        order = get_order_by_intent(intent_id) if intent_id else None
        rows.append(line_for(txn, order))
    summary = summarize(payout, rows)
    return summary, rows


def to_csv(summary, rows):
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["payout_id", summary["payout_id"]])
    writer.writerow(["payout_amount_minor", summary["payout_amount_minor"]])
    writer.writerow(["accounted_minor", summary["accounted_minor"]])
    writer.writerow(["drift_minor", summary["drift_minor"]])
    writer.writerow(["ties_out", summary["ties_out"]])
    writer.writerow([])
    writer.writerow(["balance_transaction_id", "type", "net_minor", "intent_id", "order_id", "status", "note"])
    for r in rows:
        writer.writerow([r["balance_transaction_id"], r["type"], r["net_minor"], r["intent_id"],
                          r["order_id"], r["status"], r["note"]])
    return buf.getvalue()


def run(payout_id):
    summary, rows = build_report(payout_id)
    log.info(
        "Payout %s: amount %d, accounted %d, drift %d, ties out: %s, %d line(s) need review",
        summary["payout_id"], summary["payout_amount_minor"], summary["accounted_minor"],
        summary["drift_minor"], summary["ties_out"], summary["unmatched_count"],
    )
    report = to_csv(summary, rows)
    if DRY_RUN:
        log.info("Dry run, report generated but not written or annotated:\n%s", report)
        return summary, rows
    out_path = f"payout-{summary['payout_id']}.csv"
    with open(out_path, "w", newline="") as f:
        f.write(report)
    log.info("Report written to %s", out_path)
    for row in rows:
        if row["status"] == "mismatch" and row["order_id"]:
            write_note(
                row["order_id"],
                f"Payout reconciliation: order net does not match payout {summary['payout_id']} "
                f"(drift {row['net_minor']} vs order total). Please review.",
            )
    return summary, rows


if __name__ == "__main__":
    target_payout = os.environ.get("PAYOUT_ID")
    if not target_payout:
        raise SystemExit("Set PAYOUT_ID to the po_... id you want to reconcile.")
    run(target_payout)
