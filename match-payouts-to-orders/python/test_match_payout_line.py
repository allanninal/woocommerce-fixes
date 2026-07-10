from build_payout_report import line_for, summarize, intent_id_of, source_intent_id, order_amount_minor


def balance_txn(**over):
    base = {
        "id": "txn_1",
        "type": "charge",
        "net": 4850,
        "source": {"payment_intent": "pi_1"},
    }
    base.update(over)
    return base


def order(**over):
    base = {"id": 501, "total": "50.00", "meta_data": [{"key": "_stripe_intent_id", "value": "pi_1"}]}
    base.update(over)
    return base


def test_matched_when_order_total_equals_net():
    row = line_for(balance_txn(net=5000), order(total="50.00"))
    assert row["status"] == "matched"
    assert row["order_id"] == 501


def test_mismatch_when_order_total_disagrees_with_net():
    row = line_for(balance_txn(net=4500), order(total="50.00"))
    assert row["status"] == "mismatch"
    assert "disagree" in row["note"]


def test_orphan_when_no_order_found():
    row = line_for(balance_txn(), None)
    assert row["status"] == "orphan"


def test_unmatched_when_balance_txn_has_no_intent():
    row = line_for(balance_txn(source={"payment_intent": None}), None)
    assert row["status"] == "unmatched"


def test_unmatched_when_source_is_not_a_dict():
    row = line_for(balance_txn(source="ch_no_intent_field"), None)
    assert row["status"] == "unmatched"


def test_not_a_charge_for_fee_and_refund_lines():
    assert line_for(balance_txn(type="stripe_fee", source=None), None)["status"] == "not_a_charge"
    assert line_for(balance_txn(type="payment_refund", source=None), None)["status"] == "not_a_charge"


def test_tolerance_allows_one_cent_of_rounding():
    row = line_for(balance_txn(net=4999), order(total="50.00"))
    assert row["status"] == "matched"


def test_intent_id_from_meta():
    assert intent_id_of(order()) == "pi_1"


def test_intent_id_falls_back_to_transaction_id():
    o = {"meta_data": [], "transaction_id": "pi_999"}
    assert intent_id_of(o) == "pi_999"


def test_intent_id_none_when_transaction_is_a_charge_id():
    o = {"meta_data": [], "transaction_id": "ch_999"}
    assert intent_id_of(o) is None


def test_source_intent_id_reads_nested_field():
    assert source_intent_id(balance_txn(source={"payment_intent": "pi_42"})) == "pi_42"


def test_order_amount_minor_converts_dollars_to_cents():
    assert order_amount_minor({"total": "19.99"}) == 1999


def test_summarize_ties_out_when_charges_and_fees_cover_the_payout():
    payout = {"id": "po_1", "amount": 9700}
    rows = [
        line_for(balance_txn(id="txn_1", net=5000), order(id=501, total="50.00")),
        line_for(balance_txn(id="txn_2", net=4700, source={"payment_intent": "pi_2"}),
                 order(id=502, total="47.00", meta_data=[{"key": "_stripe_intent_id", "value": "pi_2"}])),
    ]
    summary = summarize(payout, rows)
    assert summary["ties_out"] is True
    assert summary["drift_minor"] == 0
    assert summary["unmatched_count"] == 0


def test_summarize_flags_drift_when_payout_does_not_tie_out():
    payout = {"id": "po_2", "amount": 10000}
    rows = [line_for(balance_txn(net=5000), order(total="50.00"))]
    summary = summarize(payout, rows)
    assert summary["ties_out"] is False
    assert summary["drift_minor"] == 5000


def test_summarize_counts_mismatch_and_orphan_as_needing_review():
    payout = {"id": "po_3", "amount": 9500}
    rows = [
        line_for(balance_txn(id="txn_1", net=5000), order(total="45.00")),  # mismatch
        line_for(balance_txn(id="txn_2", net=4500, source={"payment_intent": "pi_9"}), None),  # orphan
    ]
    summary = summarize(payout, rows)
    assert summary["unmatched_count"] == 2
